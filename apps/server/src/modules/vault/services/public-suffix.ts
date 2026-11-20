const multiPart = new Set(
  [
    "com.br net.br org.br gov.br edu.br art.br blog.br eco.br emp.br ind.br inf.br log.br nom.br ong.br tec.br tv.br",
    "co.uk org.uk me.uk ltd.uk plc.uk net.uk ac.uk gov.uk sch.uk nhs.uk",
    "com.au net.au org.au edu.au gov.au id.au asn.au",
    "co.nz org.nz net.nz govt.nz ac.nz",
    "co.jp ne.jp or.jp ac.jp go.jp gr.jp",
    "co.kr or.kr ne.kr go.kr ac.kr",
    "com.ar com.mx com.co com.pe com.uy com.py com.bo com.ec com.ve com.cn com.hk com.tw com.sg com.my com.tr",
    "com.pt com.es com.ua com.pl com.ru com.sa com.eg com.ng com.ph com.pk com.vn com.gt com.do",
    "co.za co.in net.in org.in co.id or.id co.il org.il ac.il co.th in.th co.ke",
    "gob.mx gob.ar gob.es gouv.fr gv.at ac.at co.at or.at",
    "github.io gitlab.io pages.dev workers.dev vercel.app netlify.app herokuapp.com fly.dev web.app firebaseapp.com",
    "appspot.com azurewebsites.net cloudfront.net s3.amazonaws.com blogspot.com ngrok.io ngrok.app",
    "trycloudflare.com r2.dev supabase.co onrender.com railway.app glitch.me repl.co",
  ]
    .join(" ")
    .split(" "),
);

export function isPublicSuffix(domain: string) {
  return multiPart.has(domain.toLowerCase());
}
