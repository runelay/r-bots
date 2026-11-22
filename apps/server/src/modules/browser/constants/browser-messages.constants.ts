import { defineMessages } from "../../../shared/i18n";

export const browserText = defineMessages({
  "pt-BR": {
    urlInvalid: "Endereço inválido.",
    httpOnly: "O navegador do bot só abre endereços http ou https.",
    noPage: "Esse bot ainda não abriu nenhuma página.",
    noScreenshot: "Nenhum print ainda.",
    screenshotFailed: "Não consegui tirar o print: {reason}",
    noDesktopScreenshot: "Nenhum print do computador ainda.",
    noBrowser: "Esse bot não tem navegador.",
    useHttp: "Use uma URL http ou https.",
    openFailed: "Não consegui abrir a página: {reason}",
    modeInvalid: "Use mode user ou bot.",
    noBrowserOrComputer: "Esse bot não tem navegador nem computador.",
    browserFailed: "Falha no navegador: {reason}",
  },
  en: {
    urlInvalid: "Invalid address.",
    httpOnly: "The bot's browser only opens http or https addresses.",
    noPage: "This bot hasn't opened any page yet.",
    noScreenshot: "No screenshot yet.",
    screenshotFailed: "Couldn't take the screenshot: {reason}",
    noDesktopScreenshot: "No computer screenshot yet.",
    noBrowser: "This bot has no browser.",
    useHttp: "Use an http or https URL.",
    openFailed: "Couldn't open the page: {reason}",
    modeInvalid: "Use mode user or bot.",
    noBrowserOrComputer: "This bot has neither a browser nor a computer.",
    browserFailed: "Browser failure: {reason}",
  },
});
