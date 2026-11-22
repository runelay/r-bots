import { defineMessages } from "../../../shared/i18n";

export const questionsText = defineMessages({
  "pt-BR": {
    answerObject: "Cada resposta precisa ser um objeto.",
    questionsOrSkip: "Mande 'questions' ou optionId 'skip'.",
    unknownQuestion: "Pergunta desconhecida: '{id}'.",
    optionIdsList: "optionIds precisa ser uma lista de ids.",
    unknownOption: "Opção desconhecida '{id}' na pergunta '{question}'.",
    otherNeedsText: "“Outra coisa” precisa de texto.",
    singleOption: "A pergunta '{id}' aceita uma opção só.",
  },
  en: {
    answerObject: "Each answer must be an object.",
    questionsOrSkip: "Send 'questions' or optionId 'skip'.",
    unknownQuestion: "Unknown question: '{id}'.",
    optionIdsList: "optionIds must be a list of ids.",
    unknownOption: "Unknown option '{id}' in question '{question}'.",
    otherNeedsText: "“Something else” needs text.",
    singleOption: "The question '{id}' accepts a single option.",
  },
});
