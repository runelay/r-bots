import { defineMessages } from "../../../shared/i18n";

export const testsText = defineMessages({
  "pt-BR": {
    notFound: "Teste não encontrado.",
    realDataPrompt: "Rodar um teste que escreve dado real ({where})?",
    realDataReason: "Teste que cria ou envia algo de verdade passa por você.",
    remotePrompt: "Rodar o teste contra {url}?",
    remoteReason: "Teste fora da prévia local passa por você.",
    playwright: "Testar {path} no navegador",
    installReason: "Instalar ferramenta passa por você.",
    maestro: "Testar {path} no simulador",
    simulator: "simulador",
    localPreview: "prévia local",
    installMaestro: "Instalar o Maestro no Mac",
    installPlaywright: "Instalar o Playwright no servidor",
  },
  en: {
    notFound: "Test not found.",
    realDataPrompt: "Run a test that writes real data ({where})?",
    realDataReason: "A test that creates or sends something for real goes through you.",
    remotePrompt: "Run the test against {url}?",
    remoteReason: "A test outside the local preview goes through you.",
    playwright: "Test {path} in the browser",
    installReason: "Installing a tool goes through you.",
    maestro: "Test {path} in the simulator",
    simulator: "simulator",
    localPreview: "local preview",
    installMaestro: "Install Maestro on the Mac",
    installPlaywright: "Install Playwright on the server",
  },
});
