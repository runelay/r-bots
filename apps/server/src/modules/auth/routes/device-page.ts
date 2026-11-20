export const appCallbackUrl = "runelaybots://device-approved";

const appIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="s" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="1" stop-color="#9aa1ae"/>
    </linearGradient>
    <linearGradient id="sheen" x1="0" y1="100" x2="0" y2="420" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#FFFFFF" stop-opacity="0.08"/>
      <stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect x="100" y="100" width="824" height="824" rx="185" ry="185" fill="#0c0d0f"/>
  <rect x="100" y="100" width="824" height="824" rx="185" ry="185" fill="url(#sheen)"/>
  <rect x="101" y="101" width="822" height="822" rx="184" ry="184" fill="none" stroke="#FFFFFF" stroke-opacity="0.07" stroke-width="2"/>
  <g transform="translate(512 512) scale(0.74) translate(-512 -511.5)">
    <path d="M492 285A256 256 0 0 0 492 797Z" fill="url(#s)"/>
    <path d="M532 226A256 256 0 0 1 532 738Z" fill="url(#s)"/>
  </g>
</svg>
`;

const favicon = `data:image/svg+xml;base64,${Buffer.from(appIcon).toString("base64")}`;

const stroke = `fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"`;

const icons = {
  mail: `<svg viewBox="0 0 24 24" width="16" height="16" ${stroke}><rect x="3" y="5" width="18" height="14" rx="3"/><path d="m4 7 8 6 8-6"/></svg>`,
  lock: `<svg viewBox="0 0 24 24" width="16" height="16" ${stroke}><rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/></svg>`,
  eye: `<svg class="eye-show" viewBox="0 0 24 24" width="16" height="16" ${stroke}><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/></svg>`,
  eyeOff: `<svg class="eye-hide" viewBox="0 0 24 24" width="16" height="16" ${stroke}><path d="M10.6 5.6A9.9 9.9 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.6 3.4M6.3 6.9C3.9 8.6 2.5 12 2.5 12S6 18.5 12 18.5c1.8 0 3.4-.6 4.7-1.4M9.9 9.9a3 3 0 0 0 4.2 4.2M3 3l18 18"/></svg>`,
  touch: `<svg viewBox="0 0 24 24" width="18" height="18" ${stroke}><path d="M7.5 4.6A8.5 8.5 0 0 1 20.5 12v1M3.5 12a8.4 8.4 0 0 1 1.6-5M3.6 16.5a10 10 0 0 0 .4-4.5"/><path d="M7.4 19.7A14 14 0 0 0 8.5 12a3.5 3.5 0 0 1 7 0c0 1.1-.1 2.3-.3 3.4M12 12c0 3.3-.7 6.4-2.1 9.1M15.9 18.9c-.3.9-.7 1.8-1.1 2.6M19.8 16.6c-.2 1.1-.5 2.2-.9 3.2"/></svg>`,
  check: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>`,
  close: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17"/></svg>`,
  clock: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 8v4.5l3 1.8"/></svg>`,
};

const styles = `
:root{
  color-scheme:light dark;
  --page:#F6F7F7;--card:#FDFDFD;--surface:#F0F0F1;--surface-raised:#EAEBEC;
  --ink:#0F0F11;--muted:#67696C;--faint:#8A8C90;
  --accent:#BB3F00;--accent-hover:#A43700;--accent-ring:rgba(230,89,9,.32);
  --field-ring:rgba(15,15,17,.14);
  --success:#349D62;--danger:#D33A3C;--warning:#D58D25;
  --shadow:0 1px 2px rgba(0,0,0,.04),0 18px 48px rgba(0,0,0,.06);
}
@media (prefers-color-scheme:dark){:root{
  --page:#0E0E0F;--card:#131415;--surface:#1E1F21;--surface-raised:#232425;
  --ink:#F5F5F6;--muted:#8F9297;--faint:#67696B;
  --accent:#E65909;--accent-hover:#F06A1C;--accent-ring:rgba(253,146,62,.34);
  --field-ring:rgba(255,255,255,.16);
  --success:#5EC386;--danger:#EF6661;--warning:#EEB154;
  --shadow:0 1px 2px rgba(0,0,0,.3),0 24px 64px rgba(0,0,0,.4);
}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;min-height:100vh;min-height:100dvh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;padding:32px 16px;background:var(--page);color:var(--ink);font:400 15px/1.45 "Inter",-apple-system,BlinkMacSystemFont,system-ui,sans-serif;font-feature-settings:"cv11","ss01";-webkit-font-smoothing:antialiased}
main{width:100%;max-width:400px;background:var(--card);border-radius:24px;padding:36px 32px 32px;box-shadow:var(--shadow)}
@media (max-width:440px){main{padding:28px 20px 24px;border-radius:20px}}
.mark{position:relative;width:64px;height:64px;margin:0 auto 16px}
.mark svg{display:block;width:64px;height:64px}
.badge{position:absolute;right:-4px;bottom:-4px;width:24px;height:24px;border-radius:50%;display:none;place-items:center;color:#fff;box-shadow:0 0 0 3px var(--card)}
.badge svg{display:block;width:14px;height:14px}
[data-badge="ok"] .badge-ok{display:grid;background:var(--success)}
[data-badge="no"] .badge-no{display:grid;background:var(--faint)}
[data-badge="late"] .badge-late{display:grid;background:var(--warning)}
header{text-align:center;margin-bottom:24px}
h1:focus{outline:none}
h1{margin:0;font-size:21px;line-height:1.25;font-weight:600;letter-spacing:-.4px;text-wrap:balance}
.lede{margin:4px 0 0;font-size:13px;color:var(--muted);text-wrap:pretty}
.center{text-align:center}
.stack{display:flex;flex-direction:column;gap:8px}
.field{display:flex;flex-direction:column;gap:6px;margin-bottom:14px}
.field label{font-size:12px;font-weight:500}
.control{display:flex;align-items:center;gap:8px;height:44px;padding:0 6px 0 12px;border-radius:10px;background:var(--surface-raised);transition:box-shadow .15s ease}
.control>svg{flex:none;color:var(--faint)}
.control:focus-within{box-shadow:0 0 0 3px var(--field-ring)}
.control[data-invalid]{box-shadow:0 0 0 1.5px var(--danger)}
.control input{flex:1;min-width:0;height:100%;border:0;background:transparent;color:var(--ink);font:inherit;font-size:15px;outline:none;padding:0 6px 0 0}
.control input::placeholder{color:var(--faint)}
.reveal{flex:none;display:grid;place-items:center;width:32px;height:32px;border:0;border-radius:8px;background:transparent;color:var(--faint);cursor:pointer;padding:0}
.reveal:hover{color:var(--ink);background:var(--surface)}
.reveal:focus-visible{outline:none;box-shadow:0 0 0 3px var(--field-ring)}
.reveal .eye-hide,.reveal[aria-pressed="true"] .eye-show{display:none}
.reveal[aria-pressed="true"] .eye-hide{display:block}
.btn{position:relative;display:flex;align-items:center;justify-content:center;gap:8px;width:100%;height:44px;padding:0 20px;border:0;border-radius:999px;font:600 14px/1 "Inter",-apple-system,BlinkMacSystemFont,system-ui,sans-serif;white-space:nowrap;cursor:pointer;-webkit-tap-highlight-color:transparent;transition:background-color .15s ease,transform .2s cubic-bezier(.2,.8,.2,1),opacity .15s ease,box-shadow .15s ease}
.btn:focus{outline:none}
.btn:focus-visible{box-shadow:0 0 0 3px var(--accent-ring)}
.btn:active:not(:disabled){transform:scale(.98)}
.btn:disabled{cursor:default;opacity:.45}
.btn[aria-busy="true"]{opacity:1;cursor:progress}
.btn[aria-busy="true"] .label,.btn[aria-busy="true"]>svg{visibility:hidden}
.btn[aria-busy="true"]::after{content:"";position:absolute;width:16px;height:16px;border-radius:50%;border:2px solid currentColor;border-right-color:transparent;animation:spin .7s linear infinite}
.primary{background:var(--accent);color:#fff}
.primary:hover:not(:disabled){background:var(--accent-hover)}
.primary:active:not(:disabled){background:var(--accent)}
.secondary{background:var(--surface);color:var(--ink)}
.secondary:hover:not(:disabled){background:var(--surface-raised)}
.secondary:focus-visible{box-shadow:0 0 0 3px var(--field-ring)}
.quiet{background:transparent;color:var(--muted);height:36px;font-weight:500;font-size:13px}
.quiet:hover:not(:disabled){color:var(--ink);background:var(--surface)}
.quiet:focus-visible{box-shadow:0 0 0 3px var(--field-ring)}
.divider{display:flex;align-items:center;gap:12px;margin:20px 0;color:var(--faint);font-size:11px;font-weight:500;letter-spacing:.06em}
.divider::before,.divider::after{content:"";flex:1;height:1px;background:var(--surface-raised)}
.note{display:flex;gap:8px;align-items:flex-start;margin:0 0 20px;padding:10px 12px;border-radius:10px;background:var(--surface);color:var(--muted);font-size:13px}
.note svg{flex:none;margin-top:1px}
.code{margin:0 0 20px;padding:16px;border-radius:14px;background:var(--surface-raised);text-align:center;font:600 22px/1 "Geist Mono",ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.16em;text-indent:.16em;white-space:nowrap;overflow-wrap:normal}
.info{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;margin:0 0 20px;font-size:13px}
.info dt{color:var(--muted)}
.info dd{margin:0;overflow-wrap:anywhere}
.error{margin:0;font-size:12px;color:var(--danger);text-align:left}
.error:empty{display:none}
#error{margin-top:12px}
.spinner{display:block;width:22px;height:22px;margin:8px auto 4px;border-radius:50%;border:2px solid var(--surface-raised);border-top-color:var(--muted);animation:spin .8s linear infinite}
footer{font-size:12px;color:var(--faint)}
#result header{margin-bottom:0}
::selection{background:var(--accent-ring)}
[hidden]{display:none!important}
.view{animation:enter .28s cubic-bezier(.2,.8,.2,1)}
@keyframes enter{from{opacity:0;transform:translateY(4px)}}
@keyframes spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.view{animation:none}.btn{transition:none}.btn:active:not(:disabled){transform:none}}
`;

const script = (basePath: string) => `
const base = ${JSON.stringify(basePath)};
const callback = ${JSON.stringify(appCallbackUrl)};
const params = new URLSearchParams(location.search);
const userCode = (params.get("user_code") || "").trim().toUpperCase();
const provider = params.get("provider");
const socialError = params.get("error");
const back = "/device?user_code=" + encodeURIComponent(userCode);
const webauthn = !!(window.PublicKeyCredential && PublicKeyCredential.parseRequestOptionsFromJSON);
const $ = (id) => document.getElementById(id);
const views = ["loading", "setup", "login", "approve", "result"];
const messages = {
  "Invalid email or password": "E-mail ou senha incorretos.",
  "Invalid password": "E-mail ou senha incorretos.",
  "User not found": "E-mail ou senha incorretos.",
  "Invalid user code": "Esse código não existe. Peça um novo pelo app.",
  "User code has expired": "Esse código venceu. Peça um novo pelo app.",
  "Device code already processed": "Esse pedido já foi respondido. Peça um novo pelo app.",
  "Too many requests. Please try again later.": "Muitas tentativas. Espere um minuto e tente de novo.",
  "Device code has not been claimed by a verifying session; call \`GET /device\` with the \`user_code\` while signed in before approving or denying": "Não deu para conferir o código agora. Recarregue a página em alguns minutos.",
  "Passkey not found": "Esse Touch ID não está ligado a uma conta. Entre com a senha.",
  "Authentication failed": "Não deu para confirmar o Touch ID. Tente de novo.",
};
const translate = (message) => messages[message] || message || "Não deu certo. Tente de novo.";
function show(id) {
  for (const view of views) $(view).hidden = view !== id;
  if (id !== "result") $("mark").removeAttribute("data-badge");
  const heading = $(id).querySelector("h1");
  if (heading && document.activeElement === document.body) heading.focus({ preventScroll: true });
}
function fail(message) {
  $("error").textContent = message || "";
}
function markInvalid(invalid) {
  for (const id of ["email-control", "secret-control"]) {
    if (invalid) $(id).setAttribute("data-invalid", "");
    else $(id).removeAttribute("data-invalid");
  }
  $("email").setAttribute("aria-invalid", invalid ? "true" : "false");
  $("secret").setAttribute("aria-invalid", invalid ? "true" : "false");
}
async function busy(button, task) {
  const controls = document.querySelectorAll("button, input");
  for (const control of controls) control.disabled = true;
  button.setAttribute("aria-busy", "true");
  try {
    return await task();
  } finally {
    button.removeAttribute("aria-busy");
    for (const control of controls) control.disabled = false;
  }
}
async function call(path, init) {
  const response = await fetch(base + path, { credentials: "same-origin", headers: { "content-type": "application/json" }, ...init });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(translate(body && (body.error_description || body.message)));
    error.code = (body && (body.error || body.code)) || String(response.status);
    error.status = response.status;
    throw error;
  }
  return body;
}
function result(kind, title, text) {
  $("mark").setAttribute("data-badge", kind);
  $("result-title").textContent = title;
  $("result-text").textContent = text;
  show("result");
}
async function session() {
  try {
    const body = await call("/get-session", { method: "GET" });
    return body && body.user ? body : null;
  } catch {
    return null;
  }
}
async function hasPasskey() {
  try {
    const list = await call("/passkey/list-user-passkeys", { method: "GET" });
    return Array.isArray(list) && list.length > 0;
  } catch {
    return true;
  }
}
async function check() {
  try {
    const body = await call("/device?user_code=" + encodeURIComponent(userCode), { method: "GET" });
    if (body && body.status === "approved") return result("ok", "Esse acesso já foi liberado", "Pode voltar ao app.");
    if (body && body.status === "denied") return result("no", "Esse acesso foi recusado", "Para tentar de novo, peça um novo código pelo app.");
    return true;
  } catch (error) {
    if (error.code === "expired_token") return result("late", "Esse código venceu", "Os códigos valem por 10 minutos. Volte ao app e clique em Entrar com Touch ID de novo.");
    if (error.status === 400) return result("no", "Esse código não existe", "Confira se você abriu o link pelo app ou peça um novo código.");
    return true;
  }
}
async function needsOwner() {
  try {
    const response = await fetch("/auth/setup", { credentials: "same-origin" });
    const body = await response.json();
    return Boolean(body && body.needsOwner);
  } catch {
    return false;
  }
}
async function requestInfo() {
  try {
    const response = await fetch("/auth/device/info?user_code=" + encodeURIComponent(userCode), { credentials: "same-origin" });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}
async function enter() {
  if (!userCode) return result("no", "Abra este link pelo app", "Este endereço só funciona a partir do botão Entrar no r/bots.");
  const signedIn = await session();
  if ((await check()) !== true) return;
  if (!signedIn && (await needsOwner())) return show("setup");
  if (!signedIn) {
    show("login");
    if (socialError) return fail(socialError === "signup_disabled" ? "Essa conta ainda não tem acesso. Peça um convite." : "Não deu para entrar com essa conta.");
    if (provider) await social(provider);
    return;
  }
  $("code").textContent = userCode;
  const info = await requestInfo();
  $("info-client").textContent = info && info.clientName ? info.clientName : "desconhecido";
  $("info-ip").textContent = info && info.ip ? info.ip : "desconhecido";
  $("info-time").textContent = info && info.requestedAt ? new Date(info.requestedAt).toLocaleString("pt-BR") : "desconhecido";
  $("enroll").hidden = !webauthn || (await hasPasskey());
  show("approve");
}
async function social(id) {
  try {
    const body = await call("/sign-in/social", { method: "POST", body: JSON.stringify({ provider: id, callbackURL: back, errorCallbackURL: back, disableRedirect: true }) });
    if (body && body.url) location.href = body.url;
  } catch (error) {
    fail(error.message);
  }
}
if (!webauthn) {
  $("passkey-area").hidden = true;
  $("no-passkey").hidden = false;
  $("submit").className = "btn primary";
}
$("reveal").addEventListener("click", () => {
  const visible = $("reveal").getAttribute("aria-pressed") !== "true";
  $("reveal").setAttribute("aria-pressed", String(visible));
  $("reveal").setAttribute("aria-label", visible ? "Esconder a senha" : "Mostrar a senha");
  $("secret").type = visible ? "text" : "password";
});
for (const id of ["email", "secret"]) $(id).addEventListener("input", () => { markInvalid(false); fail(""); });
$("passkey").addEventListener("click", () => {
  fail("");
  busy($("passkey"), async () => {
    try {
      const options = await call("/passkey/generate-authenticate-options", { method: "GET" });
      const credential = await navigator.credentials.get({ publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(options) });
      await call("/passkey/verify-authentication", { method: "POST", body: JSON.stringify({ response: credential.toJSON() }) });
      await enter();
    } catch (error) {
      fail(error.name === "NotAllowedError" || error.name === "AbortError" ? "" : error.message);
    }
  });
});
$("password").addEventListener("submit", (event) => {
  event.preventDefault();
  fail("");
  busy($("submit"), async () => {
    try {
      await call("/sign-in/email", { method: "POST", body: JSON.stringify({ email: $("email").value.trim(), password: $("secret").value }) });
      $("secret").value = "";
      await enter();
    } catch (error) {
      markInvalid(error.status === 401 || error.status === 400);
      fail(error.message);
    }
  }).then(() => {
    if ($("secret").getAttribute("aria-invalid") === "true") $("secret").select();
  });
});
$("setup-form").addEventListener("submit", (event) => {
  event.preventDefault();
  fail("");
  busy($("setup-submit"), async () => {
    try {
      const email = $("setup-email").value.trim();
      const password = $("setup-secret").value;
      const response = await fetch("/auth/setup", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-setup-token": $("setup-token").value.trim() },
        body: JSON.stringify({ name: $("setup-name").value.trim(), email, password }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) return fail((body && body.error) || "Não deu certo. Tente de novo.");
      await call("/sign-in/email", { method: "POST", body: JSON.stringify({ email, password }) });
      $("setup-secret").value = "";
      $("setup-token").value = "";
      await enter();
    } catch (error) {
      fail(error.message);
    }
  });
});
$("enroll").addEventListener("click", () => {
  fail("");
  busy($("enroll"), async () => {
    try {
      const options = await call("/passkey/generate-register-options", { method: "GET" });
      const credential = await navigator.credentials.create({ publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(options) });
      await call("/passkey/verify-registration", { method: "POST", body: JSON.stringify({ response: credential.toJSON(), name: "Mac" }) });
      $("enroll").hidden = true;
      $("enrolled").hidden = false;
    } catch (error) {
      fail(error.name === "NotAllowedError" || error.name === "AbortError" ? "" : error.message);
    }
  });
});
$("allow").addEventListener("click", () => {
  fail("");
  busy($("allow"), async () => {
    try {
      await call("/device/approve", { method: "POST", body: JSON.stringify({ userCode }) });
      result("ok", "Pronto, pode voltar ao app", "O r/bots já está liberado neste Mac. Você pode fechar esta aba.");
      location.href = callback;
    } catch (error) {
      fail(error.message);
    }
  });
});
$("deny").addEventListener("click", () => {
  fail("");
  busy($("deny"), async () => {
    try {
      await call("/device/deny", { method: "POST", body: JSON.stringify({ userCode }) });
      result("no", "Acesso recusado", "O app não foi liberado. Se foi engano, peça um novo código pelo app.");
    } catch (error) {
      fail(error.message);
    }
  });
});
enter();
`;

export function devicePage(basePath: string, nonce: string) {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="referrer" content="no-referrer" />
<meta name="color-scheme" content="light dark" />
<meta name="theme-color" content="#F6F7F7" media="(prefers-color-scheme: light)" />
<meta name="theme-color" content="#0E0E0F" media="(prefers-color-scheme: dark)" />
<title>Entrar · r/bots</title>
<link rel="icon" type="image/svg+xml" href="${favicon}" />
<link rel="apple-touch-icon" href="${favicon}" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" nonce="${nonce}" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" />
<style nonce="${nonce}">${styles}</style>
</head>
<body>
<main aria-live="polite">
<div class="mark" id="mark">${appIcon}<span class="badge badge-ok">${icons.check}</span><span class="badge badge-no">${icons.close}</span><span class="badge badge-late">${icons.clock}</span></div>
<section id="loading" class="view" aria-busy="true">
<header><h1 tabindex="-1">Conferindo o código</h1><p class="lede">Só um instante.</p></header>
<span class="spinner" role="status" aria-label="Carregando"></span>
</section>
<section id="setup" class="view" hidden>
<header><h1 tabindex="-1">Criar a conta do dono</h1><p class="lede">Use o código do arquivo setup.token, que fica na pasta de dados do servidor.</p></header>
<form id="setup-form" novalidate>
<div class="field"><label for="setup-token">Código de primeiro acesso</label><div class="control">${icons.lock}<input id="setup-token" type="password" autocomplete="off" spellcheck="false" required aria-describedby="error" /></div></div>
<div class="field"><label for="setup-name">Nome</label><div class="control"><input id="setup-name" type="text" autocomplete="name" required aria-describedby="error" /></div></div>
<div class="field"><label for="setup-email">E-mail</label><div class="control">${icons.mail}<input id="setup-email" type="email" inputmode="email" autocomplete="username email" autocapitalize="off" spellcheck="false" required aria-describedby="error" /></div></div>
<div class="field"><label for="setup-secret">Senha</label><div class="control">${icons.lock}<input id="setup-secret" type="password" autocomplete="new-password" minlength="8" required aria-describedby="error" /></div></div>
<button class="btn primary" id="setup-submit" type="submit"><span class="label">Criar conta</span></button>
</form>
</section>
<section id="login" class="view" hidden>
<header><h1 tabindex="-1">Entrar no r/bots</h1><p class="lede">Para liberar o app no seu Mac.</p></header>
<div id="passkey-area">
<button class="btn primary" id="passkey" type="button">${icons.touch}<span class="label">Entrar com Touch ID</span></button>
<div class="divider" role="separator">OU</div>
</div>
<p class="note" id="no-passkey" hidden>${icons.touch}<span>Este navegador não oferece Touch ID nem chave de acesso. Entre com o e-mail e a senha.</span></p>
<form id="password" novalidate>
<div class="field">
<label for="email">E-mail</label>
<div class="control" id="email-control">${icons.mail}<input id="email" name="email" type="email" inputmode="email" autocomplete="username email webauthn" autocapitalize="off" spellcheck="false" placeholder="voce@empresa.com" required aria-describedby="error" /></div>
</div>
<div class="field">
<label for="secret">Senha</label>
<div class="control" id="secret-control">${icons.lock}<input id="secret" name="password" type="password" autocomplete="current-password" placeholder="Sua senha" required aria-describedby="error" /><button class="reveal" id="reveal" type="button" aria-pressed="false" aria-label="Mostrar a senha" aria-controls="secret">${icons.eye}${icons.eyeOff}</button></div>
</div>
<button class="btn secondary" id="submit" type="submit"><span class="label">Entrar com senha</span></button>
</form>
</section>
<section id="approve" class="view" hidden>
<header><h1 tabindex="-1">Liberar o app</h1><p class="lede">Confira se o código é o mesmo que aparece no app.</p></header>
<div class="code" id="code" aria-label="Código"></div>
<p class="note" id="request-warning">${icons.lock}<span>Só libere se foi você que pediu agora, no seu Mac. Se alguém te mandou este link, recuse.</span></p>
<dl class="info" id="request-info"><dt>Quem pediu</dt><dd id="info-client"></dd><dt>Endereço</dt><dd id="info-ip"></dd><dt>Quando</dt><dd id="info-time"></dd></dl>
<div class="stack">
<button class="btn primary" id="allow" type="button"><span class="label">Liberar</span></button>
<button class="btn secondary" id="deny" type="button"><span class="label">Recusar</span></button>
<button class="btn quiet" id="enroll" type="button" hidden>${icons.touch}<span class="label">Ativar Touch ID neste Mac</span></button>
<p class="lede center" id="enrolled" hidden>Touch ID ativado. Da próxima vez é só encostar o dedo.</p>
</div>
</section>
<section id="result" class="view" hidden>
<header><h1 tabindex="-1" id="result-title"></h1><p class="lede" id="result-text"></p></header>
</section>
<p class="error" id="error" role="alert"></p>
</main>
<footer>r/bots</footer>
<script nonce="${nonce}">${script(basePath)}</script>
</body>
</html>`;
}
