import { defineMessages } from "../../../shared/i18n";

export const environmentsText = defineMessages({
  "pt-BR": {
    vps: "VPS",
    mac: "Pessoal",
    runnerDropped: "O runner desta máquina desconectou no meio do turno.",
    hostFallback: "O runner desta máquina está desconectado; este turno roda no container do servidor.",
    macDropped: "O ambiente Pessoal desconectou no meio do turno; abra o app no Mac ou troque para VPS.",
    macOffline: "O ambiente Pessoal está desconectado; abra o app no Mac ou troque para VPS.",
    macPrepareFailed: "Não consegui preparar o código para o Mac: {reason}",
  },
  en: {
    vps: "VPS",
    mac: "Personal",
    runnerDropped: "This machine's runner disconnected in the middle of the turn.",
    hostFallback: "This machine's runner is disconnected; this turn runs in the server's container.",
    macDropped: "The Personal environment disconnected in the middle of the turn; open the app on the Mac or switch to VPS.",
    macOffline: "The Personal environment is disconnected; open the app on the Mac or switch to VPS.",
    macPrepareFailed: "Couldn't prepare the code for the Mac: {reason}",
  },
});
