async function sendWhatsAppOtp(phone, code) {
  const to = `91${phone}`;
  const text = `Your PujaDiary (పూజా డైరీ) login OTP is: ${code}. Valid for 5 minutes.`;

  // 1. Official Meta WhatsApp Cloud API (Free tier / Test numbers)
  const token = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_ID;
  if (token && phoneId) {
    const template = process.env.WHATSAPP_OTP_TEMPLATE;
    const payload = template
      ? {
          messaging_product: 'whatsapp',
          to,
          type: 'template',
          template: {
            name: template,
            language: { code: process.env.WHATSAPP_TEMPLATE_LANG || 'en' },
            components: [
              { type: 'body', parameters: [{ type: 'text', text: code }] },
              { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] },
            ],
          },
        }
      : {
          messaging_product: 'whatsapp',
          to,
          type: 'text',
          text: { body: text },
        };

    const res = await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.error?.message || `WhatsApp API failed (${res.status})`);
    }
    return { sent: true, provider: 'meta-cloud' };
  }

  // 2. Custom / Free Webhook Bridge (e.g., Green-API free tier, local Baileys/WA-Web bridge)
  const webhookUrl = process.env.WHATSAPP_WEBHOOK_URL;
  if (webhookUrl) {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: to, code, text }),
    });
    if (!res.ok) {
      throw new Error(`WhatsApp webhook failed (${res.status})`);
    }
    return { sent: true, provider: 'webhook' };
  }

  // 3. Dev fallback when no WhatsApp provider is configured yet
  console.log(`[DEV WHATSAPP OTP] To +${to}: ${code}`);
  return { sent: false, provider: 'dev' };
}

module.exports = { sendWhatsAppOtp };

