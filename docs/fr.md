# Google Assistant SDK

**Connecteur non officiel, sans lien avec Google.** Il utilise l’API Google Assistant (le « Google
Assistant SDK », service gRPC `embeddedassistant.googleapis.com`) avec **votre propre projet Google
Cloud**, pour **diffuser un message sur vos enceintes Google** depuis une scène Gladys : toutes les
enceintes du foyer, ou celles d’une pièce.

> Cette intégration n’a **jamais été testée avec un vrai compte Google ni une vraie enceinte** : elle a
> été écrite d’après l’exemple officiel de Google et les bibliothèques qui l’utilisent (voir
> `THIRD_PARTY_NOTICES.md`), et testée contre un faux Google. Le 2026-11-10, l’API répondait encore
> (elle refuse un jeton invalide avec le statut gRPC `UNAUTHENTICATED`), mais rien ne prouve qu’une
> diffusion soit encore jouée depuis que Google a remplacé l’Assistant par Gemini sur une partie des
> enceintes. Les retours sont bienvenus.

## Ce qu’elle fait

- **Action de scène « Diffuser sur les enceintes Google »** : un message (500 caractères au plus,
  variables de scène permises) et une pièce facultative (60 caractères au plus, le nom d’une pièce de
  l’app Google Home). L’intégration demande à l’Assistant, dans la langue choisie, la phrase qu’une
  personne dirait : en français « Diffuse <message> » ou « Diffuse dans <pièce> <message> », en anglais
  « broadcast <message> » ou « broadcast to <pièce> <message> ».
- **Bouton « Tester la connexion »** : demande l’heure à l’Assistant, en silence (aucune enceinte ne
  joue), et affiche sa réponse. Il vérifie le compte, le jeton et l’API sans déranger personne.
- **Bouton « Envoyer une diffusion de test »** : l’action de scène depuis l’écran de configuration.

Ce que signifie le résultat d’une action de scène ou d’un bouton :

- **« Accepté par l’Assistant Google. »** : Google a accepté la requête. Ce n’est pas une preuve
  qu’une enceinte a joué le message : l’API n’en donne aucune.
- **« Rien envoyé : … »** : la requête n’est pas partie, ou Google a dit ne pas l’avoir exécutée (jeton
  refusé, quota, requête invalide, API désactivée). L’action de scène échoue.
- **« Envoyé à l’Assistant Google, sans confirmation : … »** : la requête est partie, mais aucune
  réponse claire n’est revenue (délai dépassé, connexion perdue, erreur de Google). La diffusion a pu
  être jouée. L’action de scène échoue.

## Avant de commencer : votre projet Google Cloud

Google ne fournit pas de clé partagée : chaque utilisateur crée son propre projet (gratuit).

1. Ouvrez la [console Google Cloud](https://console.cloud.google.com/) et créez un projet (« Gladys »).
2. Activez l’**API Google Assistant** dans ce projet
   ([lien direct](https://console.cloud.google.com/apis/library/embeddedassistant.googleapis.com)).
3. **Google Auth Platform** → **Commencer** : nom de l’application (« Gladys »), adresse d’assistance,
   audience **Externe**, adresse de contact, acceptez les conditions, **Créer**.
4. **Audience** : cliquez sur **Publier l’application** pour la passer **En production**. Une
   application laissée **En test** reçoit des autorisations qui **expirent au bout de 7 jours** (il
   faudrait cliquer sur Connecter chaque semaine), et seuls les comptes listés dans **Utilisateurs
   test** peuvent se connecter. Si vous la gardez en test, ajoutez-y votre compte Google. Aucune
   validation de Google n’est nécessaire pour votre usage : l’application reste « non validée ».
5. **Clients** → **Créer un client** : type **Application Web**, nom « Gladys », et dans **URI de
   redirection autorisés** ajoutez exactement :

   ```
   https://my.gladysassistant.com/redirect/oauth
   ```

   (Si vous utilisez l’option Gladys « utiliser l’adresse de l’instance » sur un Gladys servi en HTTPS,
   ajoutez plutôt l’adresse qu’elle affiche.) Copiez l’**ID client** et le **code secret du client**.

## Configuration dans Gladys

1. **ID client** (se termine par `.apps.googleusercontent.com`) et **Code secret du client** (commence
   par `GOCSPX-`). Le code secret est gardé par Gladys dans sa base, jamais réaffiché, envoyé seulement
   à Google.
2. **Langue de l’Assistant** : la langue de votre Assistant Google (la phrase de diffusion est formulée
   dans cette langue).
3. **Enregistrez**, puis **Connecter** à côté de « Compte Google ». Google affiche un avertissement
   « Google n’a pas validé cette application » : c’est votre propre application, cliquez sur **Paramètres
   avancés** → **Accéder à Gladys (non sécurisé)**, puis autorisez « Utiliser votre Assistant Google ».
   Le statut passe à **« Compte Google lié. »**
4. Cliquez sur **Tester la connexion**, puis **Envoyer une diffusion de test**.

Utilisez le compte Google propriétaire des enceintes (celui de votre foyer dans l’app Google Home). Un
compte par Gladys.

## Limites et comportement

- **Une requête à la fois** vers Google, espacées d’**1 s** au moins, **30 en 10 minutes** au plus, et
  5 diffusions en attente au plus : une scène qui boucle reçoit « Rien envoyé » au lieu d’inonder Google.
- Chaque diffusion répond en **25 s** au plus, attente comprise (Gladys attend 30 s une action de
  scène) : une diffusion bloquée derrière des lentes reçoit « Rien envoyé : les diffusions précédentes
  ont pris trop de temps. »
- **Google demande de ralentir** (quota, HTTP 429, ou erreur de serveur) : toutes les requêtes vers
  Google s’arrêtent 60 s, puis 2, 4… minutes jusqu’à 6 h si cela recommence (ou le délai plus long que
  donne Google), pause conservée après un redémarrage. Le statut indique la reprise et se met à jour à la
  fin de la pause. Seul un succès de l’Assistant remet le doublement à zéro (un renouvellement de jeton
  ne dit rien de son quota) ; Connecter est refusé pendant une pause.
- **Google refuse l’accès** (révoqué, mot de passe changé, application encore « En test » depuis plus
  de 7 jours) ou **refuse l’ID client ou le code secret** : l’intégration cesse de demander et le statut
  l’indique, y compris après un redémarrage. C’est levé par **Connecter** (une nouvelle autorisation) ou
  par un ID client ou un code secret modifié.
- Toute autre erreur du point de jeton (réponse illisible, autre erreur HTTP, pas de réseau) n’est pas
  un refus : le renouvellement suivant attend 5 s, puis 10, 20 s… jusqu’à 1 h.
- Le jeton d’accès (1 h) vit seulement en mémoire ; une requête faite moins de 5 minutes avant son
  expiration le renouvelle d’abord. Un renouvellement qui ne finit pas dans les 25 s de la diffusion
  donne « Rien envoyé ». Si Google refuse un jeton d’accès en mémoire, il est renouvelé une fois et la
  requête renvoyée ; un jeton neuf refusé est signalé (« n’a pas accepté un jeton d’accès neuf »), pas
  pris pour un compte refusé.

Limites connues du Google Assistant SDK (aussi listées par l’intégration de Home Assistant) :

- La diffusion dans une **pièce** échoue souvent hors anglais ; laissez la pièce vide pour toucher
  toutes les enceintes.
- Les enceintes en mode **Ne pas déranger** restent muettes.
- L’API ne renvoie plus de réponse texte : « Tester la connexion » affiche le plus souvent « sans
  texte », ce qui est normal.
- Avec Gemini sur les enceintes, Google a reconnu en 2026 un défaut où une diffusion reçoit une réponse
  au lieu d’être jouée.
- La portée `assistant-sdk-prototype` est celle des exemples officiels : Google peut la fermer.

## Ce qui est gardé, et où

- Dans la configuration de Gladys : l’ID client, le code secret et le **jeton de rafraîchissement**
  écrit après Connecter (une clé hors formulaire, jamais affichée dans l’interface, jamais envoyée au
  navigateur, envoyée seulement à Google). Le jeton d’accès n’est jamais gardé.
- Dans `/data/google-assistant.json` : la fin d’une pause demandée par Google et, après un refus
  seulement, une empreinte salée de 8 bits des identifiants refusés (elle dit « peut-être les mêmes »
  sans pouvoir reconstruire un jeton). Rien d’autre.
- Le code d’autorisation passe par la page statique de Gladys `my.gladysassistant.com/redirect/oauth`
  pour revenir à votre Gladys (voir la documentation de Gladys) ; il est inutile sans votre code secret,
  qui ne va que de votre Gladys à Google. Aucun jeton n’y passe.
- Aucun jeton, code secret ni code d’autorisation dans les journaux, le statut ou les messages d’erreur.

Pour retirer l’accès : [myaccount.google.com/permissions](https://myaccount.google.com/permissions) →
votre application → **Supprimer l’accès**.

## Dépannage

- **« Erreur 400 : redirect_uri_mismatch »** : l’URI de redirection autorisé du client OAuth n’est pas
  exactement `https://my.gladysassistant.com/redirect/oauth` (sans barre finale), ou le client n’est pas
  de type **Application Web**.
- **« Erreur 403 : access_denied »** : l’application est « En test » et votre compte n’est pas
  utilisateur test. Publiez-la, ou ajoutez votre compte dans **Utilisateurs test**.
- **« Google a refusé l’accès … Cliquez de nouveau sur Connecter. »** chaque semaine : l’application est
  restée « En test ». Publiez-la, puis cliquez sur Connecter.
- **« L’Assistant Google a refusé la requête … L’API Google Assistant est-elle activée ? »** : activez
  l’**API Google Assistant** dans le projet du client OAuth, attendez quelques minutes, testez de nouveau.
- **« Google n’a pas fourni de jeton de rafraîchissement »** : Google n’en donne qu’au premier
  consentement. Retirez l’accès de votre application (lien ci-dessus), puis cliquez de nouveau sur
  Connecter.
- **Accepté, mais aucune enceinte ne joue** : vérifiez Ne pas déranger, le compte Google (celui du
  foyer), le nom de la pièce, et essayez sans pièce. Sur une enceinte qui fait tourner Gemini, la
  diffusion peut recevoir une réponse au lieu d’être jouée (défaut de Google, hors de cette intégration).
