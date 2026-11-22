import { defineMessages } from "../../../shared/i18n";

export const groupsText = defineMessages({
  "pt-BR": {
    notFound: "Grupo não encontrado.",
    threadOnly: "Grupos usam só a conversa do grupo (GET /groups/:id/thread).",
    nameEmpty: "O nome do grupo não pode ficar vazio.",
    nameTooLong: "O nome do grupo pode ter no máximo 40 caracteres.",
    membersList: "members precisa ser uma lista de ids de bots.",
    membersMin: "Um grupo precisa de pelo menos dois bots.",
    membersMax: "Um grupo pode ter no máximo 8 bots.",
    memberMissing: 'Não existe bot ativo com id "{id}".',
  },
  en: {
    notFound: "Group not found.",
    threadOnly: "Groups only use the group conversation (GET /groups/:id/thread).",
    nameEmpty: "The group name can't be empty.",
    nameTooLong: "The group name can have at most 40 characters.",
    membersList: "members must be a list of bot ids.",
    membersMin: "A group needs at least two bots.",
    membersMax: "A group can have at most 8 bots.",
    memberMissing: 'There is no active bot with id "{id}".',
  },
});
