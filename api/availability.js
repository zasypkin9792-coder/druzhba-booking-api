// /api/availability.js (Отладочная версия)
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

  const guestIn = parseDate(checkInRaw);
  const guestOut = parseDate(checkOutRaw);

  try {
    const [deals, products] = await Promise.all([
      getActiveDeals(webhook),
      getCatalog(webhook)
    ]);

    const debugLogs = [];
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
      
      const productRows = await getDealProductRows(webhook, deal.ID);
      
      let matchedRooms = [];
      const intersects = dealIn && guestOut && dealOut && guestIn < guestOut && dealOut > guestIn;

      for (const row of productRows) {
        const prodId = Number(row.PRODUCT_ID);
        let roomNum = productRoomMap.get(prodId);
        if (roomNum === undefined) {
          roomNum = extractRoomNumber(row.PRODUCT_NAME);
        }
        if (roomNum !== null) {
          matchedRooms.push({ roomNum, productName: row.PRODUCT_NAME });
          if (intersects) {
            occupied.add(roomNum);
          }
        }
      }

      debugLogs.push({
        dealId: deal.ID,
        title: deal.TITLE,
        stage: deal.STAGE_SEMANTIC_ID,
        beginDate: deal.BEGINDATE,
        closeDate: deal.CLOSEDATE,
        parsedIn: dealIn ? formatDate(dealIn) : null,
        parsedOut: dealOut ? formatDate(dealOut) : null,
        intersects,
        matchedRooms,
        productRowsCount: productRows.length
      });
    }

    res.status(200).json({
      success: true,
      debug_mode: true,
      request_dates: { check_in: checkInRaw, check_out: checkOutRaw },
      total_deals_fetched: deals.length,
      occupied_rooms_set: Array.from(occupied),
      debugLogs
    });

  } catch (err) {
    res.status(502).json({ success: false, error: err.message, stack: err.stack });
  }
};

async function bitrixCall(webhook, method, params) {
  const url = `${webhook}${method}.json`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params || {})
  });
  const data = await response.json();
  if (data.error) throw new Error(`Битрикс24 (${method}): ${data.error_description || data.error}`);
  return data;
}

async function getActiveDeals(webhook) {
  const deals = [];
  let start = 0;
  while (true) {
    const data = await bitrixCall(webhook, 'crm.deal.list', {
      select: ['ID', 'TITLE', 'STAGE_SEMANTIC_ID', 'BEGINDATE', 'CLOSEDATE'],
      order: { ID: 'ASC' },
      start
    });
    deals.push(...(data.result || []));
    if (data.next === undefined) break;
    start = data.next;
  }
  return deals;
}

async function getDealProductRows(webhook, dealId) {
  try {
    const data = await bitrixCall(webhook, 'crm.productrow.list', {
      filter: { '=OWNER_TYPE': 'D', '=OWNER_ID': dealId }
    });
    return data.result || [];
  } catch (e) {
    return [];
  }
}

async function getCatalog(webhook) {
  const products = [];
  let start = 0;
  while (true) {
    const data = await bitrixCall(webhook, 'crm.product.list', {
      select: ['ID', 'NAME', 'PRICE', 'CURRENCY_ID', 'DESCRIPTION', 'PREVIEW_PICTURE'],
      order: { ID: 'ASC' },
      start
    });
    const page = data.result || [];
    for (const item of page) {
      products.push({
        id: Number(item.ID),
        name: item.NAME || '',
        price: item.PRICE !== undefined ? Number(item.PRICE) : null,
        currency: item.CURRENCY_ID || 'KZT',
        description: item.DESCRIPTION || '',
        photo: item.PREVIEW_PICTURE || null,
        roomNumber: extractRoomNumber(item.NAME)
      });
    }
    if (data.next === undefined) break;
    start = data.next;
  }
  return products;
}

function extractRoomNumber(name) {
  if (typeof name !== 'string') return null;
  const match = name.match(/№?\s*(\d+)/u);
  if (!match) return null;
  const id = parseInt(match[1], 10);
  return id >= 1 && id <= 60 ? id : null;
}

function parseDate(value) {
  if (!value || typeof value !== 'string') return null;
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