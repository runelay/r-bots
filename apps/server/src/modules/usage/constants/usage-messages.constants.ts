import { defineMessages } from "../../../shared/i18n";

export const usageText = defineMessages({
  "pt-BR": {
    failed: "Não deu para calcular o uso: {reason}",
    session: "Sessão",
    weekly: "Semanal",
    monthly: "Mensal",
    noDir: "{account} não tem diretório de configuração.",
    notLogged: "{account} não está logado.",
    expired: "O login do {account} expirou. Ele renova no próximo turno.",
    claudeFailed: "Não deu para ler os limites do Claude: {reason}",
    codexFailed: "Não deu para ler os limites do Codex: {reason}",
  },
  en: {
    failed: "Couldn't calculate usage: {reason}",
    session: "Session",
    weekly: "Weekly",
    monthly: "Monthly",
    noDir: "{account} has no config folder.",
    notLogged: "{account} is not signed in.",
    expired: "The {account} login expired. It renews on the next turn.",
    claudeFailed: "Couldn't read the Claude limits: {reason}",
    codexFailed: "Couldn't read the Codex limits: {reason}",
  },
});
