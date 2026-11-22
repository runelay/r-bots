import { defineMessages } from "../../../shared/i18n";

export const serverVersionText = defineMessages({
  "pt-BR": {
    agent_missing: "O vigia de atualização não está instalado neste servidor. Rode rbots update no servidor.",
    update_in_progress: "Já tem uma atualização em andamento.",
    turns_running: "Há turnos rodando agora.",
    forceInvalid: "force precisa ser true ou false.",
  },
  en: {
    agent_missing: "The update watcher is not installed on this server. Run rbots update on the server.",
    update_in_progress: "An update is already in progress.",
    turns_running: "There are turns running right now.",
    forceInvalid: "force must be true or false.",
  },
});
