import { defineMessages } from "../../../shared/i18n";

export const providersText = defineMessages({
  "pt-BR": {
    providerInvalid: "Só o Claude Code e o Codex são atualizados por aqui.",
    versionMismatch: "A versão instalada não confere: esperava {version} e o CLI respondeu {found}.",
    withError: "com erro",
    npmFailed: "O npm não instalou {pkg}@{version}: {reason}",
    versionInvalid: "Versão inválida. Use algo como 2.1.330.",
    updating: "Já tem uma atualização rodando para esse CLI.",
    latestUnknown: "Não consegui descobrir a última versão. Mande a versão que você quer.",
    waitUpdate: "Espere a atualização terminar antes de voltar.",
    noPrevious: "Não há versão anterior para voltar.",
  },
  en: {
    providerInvalid: "Only Claude Code and Codex are updated here.",
    versionMismatch: "The installed version doesn't match: expected {version} and the CLI answered {found}.",
    withError: "with an error",
    npmFailed: "npm didn't install {pkg}@{version}: {reason}",
    versionInvalid: "Invalid version. Use something like 2.1.330.",
    updating: "An update is already running for this CLI.",
    latestUnknown: "Couldn't find the latest version. Send the version you want.",
    waitUpdate: "Wait for the update to finish before rolling back.",
    noPrevious: "There's no previous version to roll back to.",
  },
});
