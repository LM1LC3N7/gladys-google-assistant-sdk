// -----------------------------------------------------------------------------
// Runtime texts (en/fr): connection statuses, button results, scene errors.
// A scene action error is an Error whose message is the English text (the
// scene log shows it); the buttons and the status show both languages.
// -----------------------------------------------------------------------------

const minutes = (ms) => Math.max(1, Math.ceil(ms / 60_000));

export const T = {
  // --- statuses ---
  connected: {
    en: 'Google account linked.',
    fr: 'Compte Google lié.',
  },
  missingClient: {
    en: 'Fill in the client ID and the client secret of your Google Cloud OAuth client, then click Connect.',
    fr: 'Renseignez l’ID client et le code secret du client OAuth de votre projet Google Cloud, puis cliquez sur Connecter.',
  },
  missingLanguage: {
    en: 'Choose the language of your Google Assistant.',
    fr: 'Choisissez la langue de votre Assistant Google.',
  },
  notConnected: {
    en: 'Click Connect to link your Google account.',
    fr: 'Cliquez sur Connecter pour lier votre compte Google.',
  },
  refusedGrant: {
    en: 'Google refused the access (revoked, password changed, or app still “In testing”: 7 days). Click Connect again.',
    fr: 'Google a refusé l’accès (révoqué, mot de passe changé, ou application encore « En test » : 7 jours). Cliquez de nouveau sur Connecter.',
  },
  refusedClient: {
    en: 'Google refused the client ID or the client secret: check them, then click Connect.',
    fr: 'Google a refusé l’ID client ou le code secret : vérifiez-les, puis cliquez sur Connecter.',
  },
  paused: (ms) => ({
    en: `Google asked to slow down: requests resume in about ${minutes(ms)} min.`,
    fr: `Google a demandé de ralentir : reprise des requêtes dans ${minutes(ms)} min environ.`,
  }),
  unreachable: {
    en: 'Google cannot be reached for now; the next broadcast tries again.',
    fr: 'Google est injoignable pour l’instant ; la prochaine diffusion réessaiera.',
  },
  googleError: {
    en: 'Google answered with an error; the next broadcast tries again.',
    fr: 'Google a répondu par une erreur ; la prochaine diffusion réessaiera.',
  },
  denied: (detail) => ({
    en: `Google Assistant refused the request${detail ? ` (${detail})` : ''}. Is the Google Assistant API enabled in your Google Cloud project?`,
    fr: `L’Assistant Google a refusé la requête${detail ? ` (${detail})` : ''}. L’API Google Assistant est-elle activée dans votre projet Google Cloud ?`,
  }),
  tokenRejected: {
    en: 'Google Assistant did not accept a fresh access token. Click Connect again.',
    fr: 'L’Assistant Google n’a pas accepté un jeton d’accès neuf. Cliquez de nouveau sur Connecter.',
  },
  configUnreadable: (ms) => ({
    en: `The configuration cannot be read from Gladys; new try in ${Math.ceil(ms / 1000)} s.`,
    fr: `La configuration ne peut pas être lue depuis Gladys ; nouvel essai dans ${Math.ceil(ms / 1000)} s.`,
  }),

  // --- results ---
  accepted: {
    en: 'Accepted by Google Assistant.',
    fr: 'Accepté par l’Assistant Google.',
  },
  testOk: (answer) => ({
    en: `Google Assistant answered${answer ? `: “${answer}”` : ' (without text: normal for the Assistant SDK)'}.`,
    fr: `L’Assistant Google a répondu${answer ? ` : « ${answer} »` : ' (sans texte : normal pour l’Assistant SDK)'}.`,
  }),
  notSent: (why) => ({
    en: `Nothing sent: ${why.en}`,
    fr: `Rien envoyé : ${why.fr}`,
  }),
  unconfirmed: (why) => ({
    en: `Sent to Google Assistant, without confirmation: ${why.en}`,
    fr: `Envoyé à l’Assistant Google, sans confirmation : ${why.fr}`,
  }),

  // --- reasons ---
  notReady: {
    en: 'the integration is starting.',
    fr: 'l’intégration démarre.',
  },
  stopping: {
    en: 'the integration is stopping.',
    fr: 'l’intégration s’arrête.',
  },
  emptyMessage: {
    en: 'the message is empty.',
    fr: 'le message est vide.',
  },
  longMessage: {
    en: 'the message is longer than 500 characters.',
    fr: 'le message dépasse 500 caractères.',
  },
  badRoom: {
    en: 'the room name is longer than 60 characters.',
    fr: 'le nom de la pièce dépasse 60 caractères.',
  },
  badType: {
    en: 'a field is not text.',
    fr: 'un champ n’est pas du texte.',
  },
  queueFull: {
    en: 'too many broadcasts are already waiting.',
    fr: 'trop de diffusions attendent déjà.',
  },
  tooMany: {
    en: 'more than 30 requests to Google Assistant in 10 minutes.',
    fr: 'plus de 30 requêtes à l’Assistant Google en 10 minutes.',
  },
  tooLate: {
    en: 'the broadcasts before it took too long.',
    fr: 'les diffusions précédentes ont pris trop de temps.',
  },
  timeout: {
    en: 'Google Assistant did not answer in time.',
    fr: 'l’Assistant Google n’a pas répondu à temps.',
  },
  lost: {
    en: 'the connection to Google Assistant was lost.',
    fr: 'la connexion à l’Assistant Google a été perdue.',
  },
  badAnswer: {
    en: 'the answer of Google Assistant is unreadable.',
    fr: 'la réponse de l’Assistant Google est illisible.',
  },
  quota: {
    en: 'Google asked to slow down (quota).',
    fr: 'Google a demandé de ralentir (quota).',
  },
  serverError: {
    en: 'Google Assistant had an error.',
    fr: 'l’Assistant Google a eu une erreur.',
  },

  // --- OAuth ---
  badState: {
    en: 'This authorization is unknown or expired: click Connect again.',
    fr: 'Cette autorisation est inconnue ou expirée : cliquez de nouveau sur Connecter.',
  },
  badRedirect: {
    en: 'The redirect address changed during the authorization: click Connect again.',
    fr: 'L’adresse de retour a changé pendant l’autorisation : cliquez de nouveau sur Connecter.',
  },
  clientChanged: {
    en: 'The OAuth client changed during the authorization: click Connect again.',
    fr: 'Le client OAuth a changé pendant l’autorisation : cliquez de nouveau sur Connecter.',
  },
  codeRefused: {
    en: 'Google refused the authorization code (expired or already used): click Connect again.',
    fr: 'Google a refusé le code d’autorisation (expiré ou déjà utilisé) : cliquez de nouveau sur Connecter.',
  },
  noRefreshToken: {
    en: 'Google did not hand a refresh token: remove the access of your app at myaccount.google.com/permissions, then click Connect again.',
    fr: 'Google n’a pas fourni de jeton de rafraîchissement : retirez l’accès de votre application sur myaccount.google.com/permissions, puis cliquez de nouveau sur Connecter.',
  },
  scopeMissing: {
    en: 'The Google Assistant permission was not granted: click Connect again and allow it.',
    fr: 'L’autorisation Assistant Google n’a pas été accordée : cliquez de nouveau sur Connecter et acceptez-la.',
  },
  saveFailed: {
    en: 'Gladys could not save the Google authorization: click Connect again.',
    fr: 'Gladys n’a pas pu enregistrer l’autorisation Google : cliquez de nouveau sur Connecter.',
  },
  unknownKey: {
    en: 'Unknown connection field.',
    fr: 'Champ de connexion inconnu.',
  },
};

/** The English text of a message, for an Error. */
export const en = (message) => message.en;
