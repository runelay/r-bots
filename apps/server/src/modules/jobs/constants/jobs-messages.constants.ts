import { defineMessages } from "../../../shared/i18n";

export const jobsText = defineMessages({
  "pt-BR": {
    intRange: "{name} precisa ser um inteiro entre 1 e {max}.",
    statusInvalid: "status precisa ser {options}.",
    queueInvalid: "queue precisa ser {options}.",
    or: " ou ",
    queueOff: "A fila não está ligada.",
    notFound: "Job não encontrado.",
    unknownType: "Tipo de job desconhecido: {type}.",
    retryFailedOnly: "Só um job falho pode ser tentado de novo.",
  },
  en: {
    intRange: "{name} must be an integer between 1 and {max}.",
    statusInvalid: "status must be {options}.",
    queueInvalid: "queue must be {options}.",
    or: " or ",
    queueOff: "The queue is not on.",
    notFound: "Job not found.",
    unknownType: "Unknown job type: {type}.",
    retryFailedOnly: "Only a failed job can be retried.",
  },
});
