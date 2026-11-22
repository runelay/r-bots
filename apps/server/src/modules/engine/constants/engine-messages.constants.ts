import { defineMessages } from "../../../shared/i18n";

export const engineText = defineMessages({
  "pt-BR": {
    accountMissing: "A conta {id} não existe.",
    accountOffline: "A conta {label} está fora do ar. {detail}",
    accountLoggedOut: "A conta {label} está sem login. {detail}",
    accountNotInstalled: "A conta {label} não está instalada. {detail}",
    accountReady: "A conta {label}. {detail}",
    delegateFailed: "Falha no bot delegado.",
    turnUnfinished: "O turno não terminou.",
    botGone: "Esse bot não existe mais.",
    stopped: "A pessoa apertou Parar.",
    takenOver: "Você assumiu o computador.",
    providerFailed: "Falha no provedor.",
    limitHit: "O limite do {account} acabou.",
    limitHitUntil: "O limite do {account} acabou, volta {when}.",
    limitSuggest: " Quer que eu continue com o {account}?",
    guardStop:
      "Parei aqui porque não estava avançando no seu pedido e não quis gastar sua assinatura à toa.\n\nO que tentei:\n{tried}\n\nMe diga como seguir ou reformule o pedido.",
  },
  en: {
    accountMissing: "The account {id} doesn't exist.",
    accountOffline: "The account {label} is down. {detail}",
    accountLoggedOut: "The account {label} is signed out. {detail}",
    accountNotInstalled: "The account {label} is not installed. {detail}",
    accountReady: "The account {label}. {detail}",
    delegateFailed: "The delegated bot failed.",
    turnUnfinished: "The turn didn't finish.",
    botGone: "This bot no longer exists.",
    stopped: "The person pressed Stop.",
    takenOver: "You took over the computer.",
    providerFailed: "Provider failure.",
    limitHit: "The {account} limit ran out.",
    limitHitUntil: "The {account} limit ran out, it comes back {when}.",
    limitSuggest: " Want me to continue with {account}?",
    guardStop:
      "I stopped here because I wasn't making progress on your request and didn't want to waste your subscription.\n\nWhat I tried:\n{tried}\n\nTell me how to continue or rephrase the request.",
  },
});
