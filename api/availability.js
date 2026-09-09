// /api/availability.js (Точечная диагностика сделки №26)
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  const webhook = process.env.BITRIX_WEBHOOK;
  if (!webhook) {
    return res.status(500).json({ error: 'Нет вебхука' });
  }

  try {
    // 1. Запрашиваем конкретно сделку №26
    const dealRes = await fetch(`${webhook}crm.deal.get.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 26 })
    });
    const dealData = await dealRes.json();

    // 2. Запрашиваем товары сделки №26
    const rowsRes = await fetch(`${webhook}crm.productrow.list.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filter: { '=OWNER_TYPE': 'D', '=OWNER_ID': 26 } })
    });
    const rowsData = await rowsRes.json();

    res.status(200).json({
      success: true,
      deal: dealData.result,
      product_rows: rowsData.result
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};