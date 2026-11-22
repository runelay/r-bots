import { defineMessages } from "../../../shared/i18n";

export const notesText = defineMessages({
  "pt-BR": {
    titleRequired: "Título é obrigatório.",
    notFound: "Nota não encontrada.",
    titleTaken: "Já existe uma nota com esse título nessa pasta.",
    contentRequired: "content é obrigatório.",
    snippetMissing: "{where}: o trecho não foi encontrado.",
    headingMissing: '{where}: o título "{heading}" não foi encontrado.',
    notTask: "{where}: a linha {line} não é uma tarefa.",
    unknownOp: "{where}: operação desconhecida.",
    opsRequired: "ops é obrigatório.",
  },
  en: {
    titleRequired: "Title is required.",
    notFound: "Note not found.",
    titleTaken: "A note with this title already exists in this folder.",
    contentRequired: "content is required.",
    snippetMissing: "{where}: the snippet was not found.",
    headingMissing: '{where}: the heading "{heading}" was not found.',
    notTask: "{where}: line {line} is not a task.",
    unknownOp: "{where}: unknown operation.",
    opsRequired: "ops is required.",
  },
});
