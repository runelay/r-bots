import { defineMessages } from "../../../shared/i18n";

export const environmentsText = defineMessages({
  "pt-BR": {
    vps: "VPS",
    mac: "Este Mac",
    runnerDropped: "O runner desta máquina desconectou no meio do turno.",
    hostFallback: "O runner desta máquina está desconectado; este turno roda no container do servidor.",
    macDropped: "Este Mac desconectou no meio do turno; abra o app no Mac ou troque para VPS.",
    macOffline: "Este Mac está desconectado; abra o app no Mac ou troque para VPS.",
    macPrepareFailed: "Não consegui preparar o código para o Mac: {reason}",
  },
  en: {
    vps: "VPS",
    mac: "This Mac",
    runnerDropped: "This machine's runner disconnected in the middle of the turn.",
    hostFallback: "This machine's runner is disconnected; this turn runs in the server's container.",
    macDropped: "This Mac disconnected in the middle of the turn; open the app on the Mac or switch to VPS.",
    macOffline: "This Mac is disconnected; open the app on the Mac or switch to VPS.",
    macPrepareFailed: "Couldn't prepare the code for the Mac: {reason}",
  },
});
