// /api/availability.js
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, error: 'Используйте POST-запрос.' });
    return;
  }

  const webhook = process.env.BITRIX_WEBHOOK;
  if (!webhook) {
    res.status(500).json({ success: false, error: 'Не настроена переменная окружения BITRIX_WEBHOOK.' });
    return;
  }

  const body = req.body || {};
  const checkInRaw = body.check_in;
  const checkOutRaw = body.check_out;

  if (typeof checkInRaw !== 'string' || typeof checkOutRaw !== 'string') {
    res.status(400).json({ success: false, error: 'Нужно передать check_in и check_out (YYYY-MM-DD).' });
    return;
  }

  const guestIn = parseDate(checkInRaw);
  const guestOut = parseDate(checkOutRaw);

  if (!guestIn || !guestOut) {
    res.status(400).json({ success: false, error: 'Даты должны быть в формате YYYY-MM-DD.' });
    return;
  }
  if (guestOut <= guestIn) {
    res.status(400).json({ success: false, error: 'Дата выезда должна быть позже даты заезда.' });
    return;
  }

  try {
    const [deals, products] = await Promise.all([
      getActiveDeals(webhook),
      getCatalog(webhook)
    ]);

    const productRoomMap = new Map();
    products.forEach((p) => {
      if (p.roomNumber !== null) {
        productRoomMap.set(p.id, p.roomNumber);
      }
    });

    const occupied = new Set();

    for (const deal of deals) {
      const dealIn = parseDealDate(deal.BEGINDATE);
      const dealOut = parseDealDate(deal.CLOSEDATE);
      if (!dealIn || !dealOut || dealOut <= dealIn) continue;

      const intersects = dealIn < guestOut && dealOut > guestIn;
      if (!intersects) continue;

      const productRows = await getDealProductRows(webhook, deal.ID);
      for (const row of productRows) {
        const prodId = Number(row.PRODUCT_ID);
        let roomNum = productRoomMap.get(prodId);
        if (roomNum === undefined) {
          roomNum = extractRoomNumber(row.PRODUCT_NAME);
        }
        if (roomNum !== null && roomNum >= 1 && roomNum <= 60) {
          occupied.add(roomNum);
        }
      }
    }

    const freeRooms = products
      .filter((p) => p.roomNumber !== null && !occupied.has(p.roomNumber))
      .sort((a, b) => a.roomNumber - b.roomNumber)
      .map((p) => ({
        id: p.roomNumber,
        productId: p.id,
        name: p.name,
        price: p.price,
        currency: p.currency,
        description: p.description,
        photo: p.photo
      }));

    res.status(200).json({
      success: true,
      check_in: formatDate(guestIn),
      check_out: formatDate(guestOut),
      free_rooms: freeRooms
    });
  } catch (err) {
    res.status(502).json({ success: false, error: err.message || 'Ошибка обращения к Битрикс24.' });
  }
};

async function bitrixCall(webhook, method, params) {
  const url = `${webhook}${method}.json`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params || {})
  });
  let data;
  try {
    data = await response.json();
  } catch (e) {
    throw new Error(`Битрикс24 вернул некорректный ответ на ${method}.`);
  }
  if (data.error) {
    throw new Error(`Ошибка Битрикс24 (${method}): ${data.error_description || data.error}`);
  }
  return data;
}

async function getActiveDeals(webhook) {
  const deals = [];
  let start = 0;
  while (true) {
    const data = await bitrixCall(webhook, 'crm.deal.list', {
      filter: { "!STAGE_SEMANTIC_ID": "F" },
      select: ['ID', 'STAGE_SEMANTIC_ID', 'BEGINDATE', 'CLOSEDATE'],
      order: { ID: 'ASC' },
      start
    });
    deals.push(...(data.result || []));
    if (data.next === undefined) break;
    start = data.next;
  }
  return deals;
}

// Используем специальный метод для получения товарных позиций сделки
async function getDealProductRows(webhook, dealId) {
  try {
    const data = await bitrixCall(webhook, 'crm.deal.productrows.get', {
      id: Number(dealId)
    });
    return data.result || [];
  } catch (e) {
    return [];
  }
}

const ACCOMMODATION_ROOT_SECTION = 'Домики';

async function getCatalog(webhook) {
  const sectionIds = await getAccommodationSectionIds(webhook);
  const products = [];
  let start = 0;

  while (true) {
    const data = await bitrixCall(webhook, 'crm.product.list', {
      select: ['ID', 'NAME', 'PRICE', 'CURRENCY_ID', 'DESCRIPTION', 'PREVIEW_PICTURE', 'DETAIL_PICTURE', 'SECTION_ID'],
      order: { ID: 'ASC' },
      start
    });

    const page = data.result || [];
    for (const item of page) {
      if (sectionIds.size > 0 && !sectionIds.has(Number(item.SECTION_ID))) continue;

      products.push({
        id: Number(item.ID),
        name: item.NAME || '',
        price: item.PRICE !== undefined ? Number(item.PRICE) : null,
        currency: item.CURRENCY_ID || 'KZT',
        description: item.DESCRIPTION || '',
        photo: item.PREVIEW_PICTURE || item.DETAIL_PICTURE || null,
        roomNumber: extractRoomNumber(item.NAME)
      });
    }

    if (data.next === undefined) break;
    start = data.next;
  }

  return products;
}

async function getAccommodationSectionIds(webhook) {
  const sections = [];
  let start = 0;
  while (true) {
    const data = await bitrixCall(webhook, 'crm.productsection.list', {
      select: ['ID', 'NAME', 'SECTION_ID'],
      order: { ID: 'ASC' },
      start
    });
    sections.push(...(data.result || []));
    if (data.next === undefined) break;
    start = data.next;
  }

  const root = sections.find(
    (s) => (s.NAME || '').trim().toLowerCase() === ACCOMMODATION_ROOT_SECTION.toLowerCase()
  );

  if (!root) return new Set();

  const ids = new Set([Number(root.ID)]);
  let added = true;
  while (added) {
    added = false;
    for (const s of sections) {
      const parentId = Number(s.SECTION_ID);
      const sectionId = Number(s.ID);
      if (ids.has(parentId) && !ids.has(sectionId)) {
        ids.add(sectionId);
        added = true;
      }
    }
  }
  return ids;
}

function extractRoomNumber(name) {
  if (typeof name !== 'string') return null;
  const match = name.match(/№?\s*(\d+)/u);
  if (!match) return null;
  const id = parseInt(match[1], 10);
  return id >= 1 && id <= 60 ? id : null;
}

function parseDate(value) {
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  const date = new Date(`${trimmed}T00:00:00Z`);
  return isNaN(date.getTime()) ? null : date;
}

function parseDealDate(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const datePart = value.trim().slice(0, 10);
  const date = new Date(`${datePart}T00:00:00Z`);
  return isNaN(date.getTime()) ? null : date;
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}
