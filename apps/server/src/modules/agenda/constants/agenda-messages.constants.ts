import { defineMessages } from "../../../shared/i18n";

export const agendaText = defineMessages({
  "pt-BR": {
    accountNotFound: "Conta de agenda não encontrada.",
    eventNotFound: "Evento não encontrado.",
    untitled: "(sem título)",
    required: "{field} é obrigatório.",
    invalid: "{field} inválido.",
    maxRange: "Período de no máximo {days} dias.",
    noMeet: "O conector do Google Calendar ainda não cria link do Meet.",
    titleRequired: "title é obrigatório.",
    noEvent: "O Google Calendar não devolveu o evento criado.",
    calendarNotFound: "Calendário não encontrado nessa conta.",
    eventMissing: "Evento não encontrado; liste a agenda do período antes de editar.",
  },
  en: {
    accountNotFound: "Calendar account not found.",
    eventNotFound: "Event not found.",
    untitled: "(untitled)",
    required: "{field} is required.",
    invalid: "Invalid {field}.",
    maxRange: "Period of at most {days} days.",
    noMeet: "The Google Calendar connector doesn't create Meet links yet.",
    titleRequired: "title is required.",
    noEvent: "Google Calendar didn't return the created event.",
    calendarNotFound: "Calendar not found in this account.",
    eventMissing: "Event not found; list the calendar for the period before editing.",
  },
});
