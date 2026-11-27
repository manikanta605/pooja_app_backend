const nodemailer = require('nodemailer');

function getTransporter() {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) return null;

  return nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user, pass },
  });
}

async function sendPasswordResetEmail(to, name, code) {
  const transporter = getTransporter();
  const subject = 'PujaDiary (పూజా డైరీ) – Password Reset Code';
  const text = `Namaskaram ${name},\n\nYour PujaDiary password reset code is: ${code}\nThis code expires in 10 minutes.\n\nIf you did not request this, please ignore this email.\n- PujaDiary (AKP Info Solutions)`;
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:20px;border:1px solid #EADFCB;border-radius:12px;background:#FFF9F0">
      <h2 style="color:#7F1D1D;margin-top:0">PujaDiary – పూజా డైరీ</h2>
      <p>Namaskaram <strong>${name}</strong>,</p>
      <p>Your password reset verification code is:</p>
      <div style="font-size:28px;font-weight:bold;letter-spacing:6px;color:#D97706;background:#FFFFFF;padding:12px 16px;border-radius:8px;text-align:center;border:1px solid #EADFCB">${code}</div>
      <p style="color:#78716C;font-size:13px;margin-top:16px">This code expires in 10 minutes.</p>
    </div>
  `;

  if (!transporter) {
    console.log(`[DEV EMAIL] Password reset code for ${to}: ${code}`);
    return { sent: false };
  }

  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject,
    text,
    html,
  });
  return { sent: true };
}

module.exports = { sendPasswordResetEmail };

