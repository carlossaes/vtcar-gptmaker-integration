// Envio de e-mail por SMTP. Proposital nao amarrar num provedor especifico:
// Brevo, SendGrid, Gmail ou qualquer outro funcionam trocando so as
// variaveis de ambiente.
//
// Variaveis esperadas (exemplo com Brevo):
//   SMTP_HOST=smtp-relay.brevo.com
//   SMTP_PORT=587
//   SMTP_USER=xxxxx@smtp-brevo.com
//   SMTP_PASS=<senha SMTP>
//   MAIL_FROM="VT Car CRM <contato@seudominio.com.br>"
//   APP_URL=https://vtcar-crm-web.vercel.app

const nodemailer = require('nodemailer');

let transportador = null;

function configurado() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function pegarTransportador() {
  if (transportador) return transportador;
  if (!configurado()) return null;

  const porta = Number(process.env.SMTP_PORT || 587);
  transportador = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: porta,
    secure: porta === 465, // 465 = TLS direto; 587 = STARTTLS
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  return transportador;
}

/**
 * Envia um e-mail. Se o SMTP ainda nao estiver configurado, NAO quebra:
 * escreve o conteudo no log do servidor. Assim o CRM continua funcionando
 * (e da pra recuperar a senha olhando o log) enquanto o e-mail nao entra.
 */
async function enviar({ para, assunto, texto, html }) {
  if (!configurado()) {
    console.warn(
      `[mailer] SMTP nao configurado. E-mail NAO enviado.\n` +
      `  Para: ${para}\n  Assunto: ${assunto}\n  Conteudo:\n${texto}`
    );
    return { enviado: false, motivo: 'smtp-nao-configurado' };
  }

  try {
    const info = await pegarTransportador().sendMail({
      from: process.env.MAIL_FROM || process.env.SMTP_USER,
      to: para,
      subject: assunto,
      text: texto,
      html: html || undefined,
    });
    console.log(`[mailer] Enviado para ${para}: ${info.messageId}`);
    return { enviado: true, id: info.messageId };
  } catch (err) {
    console.error(`[mailer] Falha ao enviar para ${para}:`, err.message);
    return { enviado: false, motivo: err.message };
  }
}

const appUrl = () => (process.env.APP_URL || 'https://vtcar-crm-web.vercel.app').replace(/\/+$/, '');

// Layout unico pros e-mails, no visual do CRM.
function moldura(titulo, corpoHtml) {
  return `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#f6f7f9;padding:24px;font-family:-apple-system,'Segoe UI',Roboto,sans-serif;color:#0e1116">
  <div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #e3e7ed;border-radius:14px;overflow:hidden">
    <div style="padding:20px 24px;border-bottom:1px solid #e3e7ed;display:flex;align-items:center">
      <span style="display:inline-block;width:30px;height:30px;line-height:30px;text-align:center;border-radius:8px;background:#c81e2c;color:#fff;font-weight:800;font-size:12px">VT</span>
      <span style="margin-left:10px;font-weight:700;font-size:15px">VT Car CRM</span>
    </div>
    <div style="padding:24px">
      <h1 style="margin:0 0 14px;font-size:17px">${titulo}</h1>
      ${corpoHtml}
    </div>
  </div>
  <p style="max-width:520px;margin:14px auto 0;font-size:11.5px;color:#808a98;text-align:center">
    Se você não esperava este e-mail, pode ignorá-lo com segurança.
  </p>
</body></html>`;
}

const botao = (url, texto) =>
  `<p style="margin:20px 0"><a href="${url}" style="display:inline-block;background:#c81e2c;color:#fff;text-decoration:none;font-weight:600;font-size:14px;padding:11px 20px;border-radius:10px">${texto}</a></p>`;

const caixaSenha = (senha) =>
  `<p style="margin:16px 0;padding:14px;background:#f1f3f6;border:1px solid #e3e7ed;border-radius:10px;font-family:ui-monospace,Menlo,monospace;font-size:18px;letter-spacing:1px;text-align:center">${senha}</p>`;

async function enviarBoasVindas({ nome, email, senha }) {
  const url = appUrl();
  return enviar({
    para: email,
    assunto: 'Seu acesso ao VT Car CRM',
    texto:
      `Olá, ${nome}!\n\nSua conta no VT Car CRM foi criada.\n\n` +
      `Endereço: ${url}\nE-mail: ${email}\nSenha temporária: ${senha}\n\n` +
      `No primeiro acesso o sistema vai pedir que você troque essa senha.\n`,
    html: moldura(
      `Olá, ${nome}! Sua conta foi criada.`,
      `<p style="margin:0;font-size:14px;line-height:1.6;color:#5a6472">Entre com o e-mail <b style="color:#0e1116">${email}</b> e a senha temporária abaixo:</p>
       ${caixaSenha(senha)}
       ${botao(url, 'Acessar o CRM')}
       <p style="margin:0;font-size:12.5px;color:#808a98;line-height:1.6">No primeiro acesso você vai definir uma senha própria. Guarde-a: ninguém consegue ver sua senha depois disso, nem eu.</p>`
    ),
  });
}

async function enviarRecuperacao({ nome, email, token }) {
  const url = `${appUrl()}/?reset=${encodeURIComponent(token)}`;
  return enviar({
    para: email,
    assunto: 'Recuperar sua senha — VT Car CRM',
    texto:
      `Olá, ${nome}!\n\nRecebemos um pedido para redefinir sua senha no VT Car CRM.\n\n` +
      `Abra este link para criar uma nova senha (vale por 1 hora):\n${url}\n\n` +
      `Se não foi você quem pediu, ignore este e-mail — sua senha continua a mesma.\n`,
    html: moldura(
      'Redefinir sua senha',
      `<p style="margin:0;font-size:14px;line-height:1.6;color:#5a6472">Olá, ${nome}. Clique no botão para criar uma nova senha. O link vale por <b style="color:#0e1116">1 hora</b> e só pode ser usado uma vez.</p>
       ${botao(url, 'Criar nova senha')}
       <p style="margin:0;font-size:12.5px;color:#808a98;line-height:1.6">Se não foi você quem pediu, ignore este e-mail — sua senha continua a mesma.</p>`
    ),
  });
}

module.exports = { enviar, enviarBoasVindas, enviarRecuperacao, configurado, appUrl };
