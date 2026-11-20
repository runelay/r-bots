export const appCallbackUrl = "runelaybots://device-approved";

export function devicePage(basePath: string) {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="referrer" content="no-referrer" />
<title>runelay bots</title>
<style>
:root{--bg:#f6f5f2;--card:#ffffff;--ink:#111111;--muted:#6b6b6b;--accent:#f0a050;--field:#f0eee9;--error:#c4442b}
@media (prefers-color-scheme:dark){:root{--bg:#111111;--card:#1b1b1b;--ink:#f3f2ef;--muted:#9a9a9a;--field:#262626;--error:#ff7a5c}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:15px/1.45 -apple-system,BlinkMacSystemFont,"Geist",system-ui,sans-serif}
main{width:min(380px,calc(100vw - 32px));background:var(--card);border-radius:22px;padding:28px;box-shadow:0 20px 60px rgba(0,0,0,.12)}
h1{font-size:20px;margin:0 0 4px;letter-spacing:-.01em}
p{margin:0 0 18px;color:var(--muted)}
.brand{display:flex;align-items:center;gap:8px;margin-bottom:20px;font-weight:600}
.dot{width:10px;height:10px;border-radius:50%;background:var(--accent)}
.code{font:600 22px/1 ui-monospace,"Geist Mono",monospace;letter-spacing:.12em;white-space:nowrap;background:var(--field);border-radius:12px;padding:12px 14px;text-align:center;margin-bottom:18px}
input{width:100%;border:0;border-radius:12px;background:var(--field);color:var(--ink);padding:12px 14px;font:inherit;margin-bottom:10px;outline:none}
input:focus{box-shadow:0 0 0 2px var(--accent)}
button{width:100%;border:0;border-radius:12px;padding:12px 14px;font:600 15px/1 inherit;cursor:pointer;white-space:nowrap;transition:transform .2s cubic-bezier(.2,.8,.2,1),opacity .2s}
button:active{transform:scale(.98)}
button:disabled{opacity:.5;cursor:default}
.primary{background:var(--accent);color:#111}
.ghost{background:var(--field);color:var(--ink);margin-top:10px}
.error{color:var(--error);min-height:20px;margin-top:10px;font-size:13px}
[hidden]{display:none!important}
</style>
</head>
<body>
<main>
<div class="brand"><span class="dot"></span>runelay bots</div>
<section id="login" hidden>
<h1>Entrar</h1>
<p>Para liberar o app no seu Mac.</p>
<button class="primary" id="passkey">Entrar com Touch ID</button>
<form id="password" style="margin-top:14px">
<input id="email" type="email" autocomplete="username webauthn" placeholder="E-mail" required />
<input id="secret" type="password" autocomplete="current-password" placeholder="Senha" required />
<button class="ghost" type="submit">Entrar com senha</button>
</form>
</section>
<section id="approve" hidden>
<h1>Liberar o app</h1>
<p>Confira se o código é o mesmo que aparece no app.</p>
<div class="code" id="code"></div>
<button class="primary" id="allow">Liberar</button>
<button class="ghost" id="deny">Recusar</button>
<button class="ghost" id="enroll" hidden>Ativar Touch ID neste Mac</button>
</section>
<section id="done" hidden>
<h1>Pronto</h1>
<p id="doneText">Pode voltar para o app.</p>
</section>
<div class="error" id="error"></div>
</main>
<script>
const base = ${JSON.stringify(basePath)};
const callback = ${JSON.stringify(appCallbackUrl)};
const params = new URLSearchParams(location.search);
const userCode = (params.get("user_code") || "").toUpperCase();
const provider = params.get("provider");
const socialError = params.get("error");
const back = "/device?user_code=" + encodeURIComponent(userCode);
const $ = (id) => document.getElementById(id);
const show = (id) => { for (const s of ["login","approve","done"]) $(s).hidden = s !== id; };
const fail = (message) => { $("error").textContent = message || ""; };
async function call(path, init) {
  const response = await fetch(base + path, { credentials: "same-origin", headers: { "content-type": "application/json" }, ...init });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error((body && (body.error_description || body.message)) || "Não deu certo. Tente de novo.");
  return body;
}
async function session() {
  try { const body = await call("/get-session", { method: "GET" }); return body && body.user ? body : null; } catch { return null; }
}
async function hasPasskey() {
  try { const list = await call("/passkey/list-user-passkeys", { method: "GET" }); return Array.isArray(list) && list.length > 0; } catch { return true; }
}
async function enter() {
  if (!userCode) { show("done"); $("doneText").textContent = "Abra este link pelo app."; return; }
  if (!(await session())) {
    show("login");
    if (socialError) { fail(socialError === "signup_disabled" ? "Essa conta ainda não tem acesso. Peça um convite." : "Não deu para entrar com essa conta."); return; }
    if (provider) await social(provider);
    return;
  }
  $("code").textContent = userCode;
  $("enroll").hidden = !window.PublicKeyCredential || (await hasPasskey());
  show("approve");
}
async function social(id) {
  try {
    const body = await call("/sign-in/social", { method: "POST", body: JSON.stringify({ provider: id, callbackURL: back, errorCallbackURL: back, disableRedirect: true }) });
    if (body && body.url) location.href = body.url;
  } catch (error) { fail(error.message); }
}
$("passkey").onclick = async () => {
  fail("");
  try {
    const options = await call("/passkey/generate-authenticate-options", { method: "GET" });
    const credential = await navigator.credentials.get({ publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(options) });
    await call("/passkey/verify-authentication", { method: "POST", body: JSON.stringify({ response: credential.toJSON() }) });
    await enter();
  } catch (error) { fail(error.name === "NotAllowedError" ? "" : error.message); }
};
$("password").onsubmit = async (event) => {
  event.preventDefault();
  fail("");
  try {
    await call("/sign-in/email", { method: "POST", body: JSON.stringify({ email: $("email").value, password: $("secret").value }) });
    $("secret").value = "";
    await enter();
  } catch (error) { fail(error.message); }
};
$("enroll").onclick = async () => {
  fail("");
  try {
    const options = await call("/passkey/generate-register-options", { method: "GET" });
    const credential = await navigator.credentials.create({ publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(options) });
    await call("/passkey/verify-registration", { method: "POST", body: JSON.stringify({ response: credential.toJSON(), name: "Mac" }) });
    $("enroll").hidden = true;
  } catch (error) { fail(error.name === "NotAllowedError" ? "" : error.message); }
};
$("allow").onclick = async () => {
  fail("");
  try {
    await call("/device/approve", { method: "POST", body: JSON.stringify({ userCode }) });
    show("done");
    location.href = callback;
  } catch (error) { fail(error.message); }
};
$("deny").onclick = async () => {
  fail("");
  try {
    await call("/device/deny", { method: "POST", body: JSON.stringify({ userCode }) });
    show("done");
    $("doneText").textContent = "Acesso recusado.";
  } catch (error) { fail(error.message); }
};
enter();
</script>
</body>
</html>`;
}
