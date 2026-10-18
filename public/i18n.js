// Languages: English (written in the code) and French.
// The page is written in English. Every visible text, title, label and
// placeholder is looked up here and swapped for its translation, including text
// the code sets later (toasts, statuses, buttons), which a MutationObserver
// catches as it appears. Entries with {0}, {1}… match text with names or numbers
// in it. Anything inside translate="no" (names, chat messages, file names) is
// left alone.
'use strict';

const I18n = (() => {
  const FR = {
    // ---------- home
    'Switch light or dark': 'Passer en clair ou en sombre',
    'Settings': 'Réglages',
    'Voice, screens and files, straight to your friend.': 'La voix, l’écran et les fichiers, en direct avec tes amis.',
    "Miserecord can't use your microphone or share your screen from here. Open the Miserecord app, or open": 'Miserecord ne peut pas utiliser ton micro ni partager ton écran ici. Ouvre l’application Miserecord, ou ouvre',
    'directly from its folder.': 'directement depuis son dossier.',
    'Name': 'Nom',
    'Your name': 'Ton nom',
    'Group call': 'Appel de groupe',
    'Create a lobby': 'Créer un salon',
    'Code': 'Code',
    'Join': 'Rejoindre',
    'You get one code to share. Anyone who has it can join, up to 8 people.': 'Tu obtiens un code à partager. Toute personne qui l’a peut rejoindre, jusqu’à 8 personnes.',
    'Friends': 'Amis',
    'Getting ready for calls': 'Préparation des appels',
    'Ready for calls': 'Prêt pour les appels',
    'Connecting to relays': 'Connexion aux relais',
    'Add a friend': 'Ajouter un ami',
    'Start a call': 'Lancer un appel',
    'Join a call': 'Rejoindre un appel',
    'Join with a code': 'Rejoindre avec un code',
    "You'll swap two codes with your friend over any chat app. After that first call they're saved here, so next time you just press Call.": 'Tu échanges deux codes avec ton ami via n’importe quelle messagerie. Après ce premier appel, il est enregistré ici : la prochaine fois, appuie simplement sur Appeler.',
    'Swap two codes once with someone new. After that, they show up above.': 'Échange deux codes une seule fois avec quelqu’un de nouveau. Ensuite, il apparaît au-dessus.',
    'Swap two codes with your friend over any chat app.': 'Échange deux codes avec ton ami via n’importe quelle messagerie.',
    'Call': 'Appeler',
    'Remove {0}': 'Retirer {0}',
    'Last call today': 'Dernier appel aujourd’hui',
    'Last call yesterday': 'Dernier appel hier',
    'Last call {0} days ago': 'Dernier appel il y a {0} jours',

    // ---------- codes
    'Preparing your code…': 'Préparation de ton code…',
    'Preparing your reply code…': 'Préparation de ton code de réponse…',
    'Copy code': 'Copier le code',
    'Paste the code here': 'Colle le code ici',
    'Connect': 'Se connecter',
    'Create reply': 'Créer la réponse',
    'Cancel': 'Annuler',
    'Show details': 'Afficher les détails',
    'Hide details': 'Masquer les détails',
    '1. Send this code to your friend': '1. Envoie ce code à ton ami',
    '2. Send this reply code back to your friend': '2. Renvoie ce code de réponse à ton ami',
    "2. Paste your friend's reply code": '2. Colle le code de réponse de ton ami',
    "1. Paste your friend's code": '1. Colle le code de ton ami',
    'Your friend': 'Ton ami',
    "Waiting for your friend's code": 'En attente du code de ton ami',
    'Connecting directly to your friend…': 'Connexion directe à ton ami…',
    'Send the reply code back. Connecting once they paste it…': 'Renvoie le code de réponse. La connexion démarre dès qu’il le colle…',
    "Send the code, then paste your friend's reply": 'Envoie le code, puis colle la réponse de ton ami',
    "That doesn't look like a Miserecord code. Copy the whole thing.": 'Ça ne ressemble pas à un code Miserecord. Copie-le en entier.',
    "That's a start code. Paste your friend's reply code instead.": 'C’est un code de départ. Colle plutôt le code de réponse de ton ami.',
    "That's a reply code. Paste the code from the friend who started the call.": 'C’est un code de réponse. Colle le code de l’ami qui a lancé l’appel.',
    'Code copied': 'Code copié',
    'Press Ctrl+C to copy': 'Appuie sur Ctrl+C pour copier',

    // ---------- lobby
    'Lobby': 'Salon',
    'Copy lobby code': 'Copier le code du salon',
    'Lock the lobby': 'Verrouiller le salon',
    'Unlock the lobby': 'Déverrouiller le salon',
    'Remove from the lobby': 'Retirer du salon',
    'Remove {0} from the lobby?': 'Retirer {0} du salon ?',
    'Joining the lobby': 'Connexion au salon',
    'Looking for the people in it.': 'Recherche des personnes présentes.',
    'Waiting for people to join': 'En attente de participants',
    'Waiting for an answer': 'En attente d’une réponse',
    'That code needs 16 letters and numbers, like 7KQ4-XM2P-9DTA-H3VW.': 'Ce code doit contenir 16 lettres et chiffres, comme 7KQ4-XM2P-9DTA-H3VW.',
    'Nobody answered. Check the code, and make sure someone in the lobby has Miserecord open.': 'Personne n’a répondu. Vérifie le code, et assure-toi que quelqu’un dans le salon a Miserecord ouvert.',
    'This lobby is locked. Ask the host to unlock it.': 'Ce salon est verrouillé. Demande à l’hôte de le déverrouiller.',
    'This lobby is full. Up to {0} people can be in one.': 'Ce salon est plein. Il accueille jusqu’à {0} personnes.',
    'Lobby locked. Nobody new can join.': 'Salon verrouillé. Plus personne ne peut rejoindre.',
    'Lobby unlocked': 'Salon déverrouillé',
    'Lobby code copied': 'Code du salon copié',
    'The host locked the lobby': 'L’hôte a verrouillé le salon',
    'The host unlocked the lobby': 'L’hôte a déverrouillé le salon',
    'The host removed you from the lobby': 'L’hôte t’a retiré du salon',
    '{0} left the lobby': '{0} a quitté le salon',
    'Share this code to invite people': 'Partage ce code pour inviter du monde',

    // ---------- calling
    'Ringing': 'Ça sonne',
    'Connecting…': 'Connexion…',
    'Connecting to {0}': 'Connexion à {0}',
    'Setting up a direct connection.': 'Mise en place d’une connexion directe.',
    '{0} is calling': '{0} t’appelle',
    '{0} is calling · Miserecord': '{0} t’appelle · Miserecord',
    'Calls go straight between you two.': 'Les appels passent directement entre vous deux.',
    'Decline': 'Refuser',
    'Answer': 'Répondre',
    "{0} didn't pick up. They need Miserecord open to get calls.": '{0} n’a pas répondu. Miserecord doit être ouvert pour recevoir des appels.',
    'Missed call from {0}': 'Appel manqué de {0}',
    '{0} is in another call': '{0} est déjà en appel',
    "{0} can't talk right now": '{0} ne peut pas parler pour le moment',
    "Couldn't connect to {0}. A strict firewall may be blocking direct connections.": 'Impossible de se connecter à {0}. Un pare-feu strict bloque peut-être les connexions directes.',
    "Can't reach the relays right now. Check your internet connection.": 'Impossible de joindre les relais. Vérifie ta connexion internet.',
    'Connected directly': 'Connecté en direct',
    '{0} ms on your network': '{0} ms sur ton réseau',
    '{0} ms over the internet': '{0} ms via internet',
    'on your network': 'sur ton réseau',
    'over the internet': 'via internet',
    'to {0} people': 'avec {0} personnes',
    'Connection to {0} interrupted. Trying to recover…': 'Connexion avec {0} interrompue. Tentative de reprise…',
    'Connection to {0} failed. Retrying…': 'Connexion avec {0} échouée. Nouvel essai…',
    "Couldn't keep a direct connection to {0}.": 'Impossible de garder une connexion directe avec {0}.',
    'No direct route found. A strict firewall or NAT is blocking it, and no relay is used by design.': 'Aucune route directe trouvée. Un pare-feu ou un NAT strict la bloque, et aucun relais n’est utilisé, par choix.',
    '{0} left the call': '{0} a quitté l’appel',
    '{0} is saved. Next time, just press Call.': '{0} est enregistré. La prochaine fois, appuie simplement sur Appeler.',
    "These two windows share the same saved data, so they can't save each other as friends. Use a second computer or Windows account for the other one.": 'Ces deux fenêtres partagent les mêmes données, elles ne peuvent donc pas s’enregistrer comme amis. Utilise un autre ordinateur ou un autre compte Windows pour la deuxième.',
    'Waiting for microphone permission. Check the prompt near the address bar.': 'En attente de l’autorisation du micro. Regarde la demande près de la barre d’adresse.',
    'No microphone access. You can still listen, chat and share.': 'Pas d’accès au micro. Tu peux quand même écouter, écrire et partager.',
    'Network settings reset. They apply from your next call.': 'Réglages réseau réinitialisés. Ils s’appliquent dès ton prochain appel.',
    'Network settings reset': 'Réglages réseau réinitialisés',

    // ---------- call screen
    'Muted': 'Micro coupé',
    'You': 'Toi',
    'Waiting for your friend': 'En attente de ton ami',
    "{0}'s volume": 'Volume de {0}',
    'Share your screen': 'Partager ton écran',
    'Stream a video or song': 'Diffuser une vidéo ou une musique',
    'Exit full screen': 'Quitter le plein écran',
    'Full screen': 'Plein écran',
    'Call controls': 'Commandes d’appel',
    'Mute': 'Couper le micro',
    'Unmute': 'Réactiver le micro',
    'Mute everyone else': 'Couper le son des autres',
    'Hear everyone again': 'Réentendre tout le monde',
    'Share screen': 'Partager l’écran',
    'Stop sharing': 'Arrêter le partage',
    'Stream a file': 'Diffuser un fichier',
    'Stream file': 'Diffuser un fichier',
    'Stop streaming': 'Arrêter la diffusion',
    'Chat': 'Discussion',
    'Leave': 'Quitter',
    'Hide chat': 'Masquer la discussion',
    "Messages and files go straight to your friend and aren't saved anywhere. Drop files here to send them.": 'Les messages et fichiers vont directement à ton ami et ne sont enregistrés nulle part. Dépose des fichiers ici pour les envoyer.',
    'Send files': 'Envoyer des fichiers',
    'Send': 'Envoyer',
    'Message': 'Message',
    'Close': 'Fermer',
    'Your screen': 'Ton écran',
    "{0}'s screen": 'Écran de {0}',
    'Streaming: {0}': 'Diffusion : {0}',
    '{0} is streaming: {1}': '{0} diffuse : {1}',
    'Add friend': 'Ajouter en ami',
    'Request sent': 'Demande envoyée',
    'Wants to be friends': 'Veut être ton ami',
    'Accept friend request': 'Accepter la demande d’ami',
    '{0} wants to add you as a friend': '{0} veut t’ajouter en ami',
    '{0} is now your friend. Call them anytime from the home screen.': '{0} est maintenant ton ami. Appelle-le quand tu veux depuis l’accueil.',
    'Zoom in': 'Zoomer',
    'Back to the whole picture': 'Revenir à l’image entière',
    'Sound': 'Son',
    'Your microphone': 'Ton micro',
    'How loud you are for everyone': 'Ton volume pour les autres',
    'Your voice': 'Ta voix',
    'Voices': 'Voix',
    'Nobody else is here yet': 'Personne d’autre pour l’instant',
    'Everything you watch': 'Tout ce que tu regardes',
    'More sound settings': 'Plus de réglages du son',
    'Microphone volume': 'Volume du micro',
    "Everyone's voices": 'Voix de tout le monde',
    'Stream volume': 'Volume du stream',
    'Stream volume {0}%': 'Volume du stream {0} %',
    'Stream quality': 'Qualité du stream',
    'Low': 'Basse',
    'Medium': 'Moyenne',
    'High': 'Haute',
    '720p, 30 fps, up to 2.5 Mbps': '720p, 30 i/s, jusqu’à 2,5 Mb/s',
    '1080p, 60 fps, up to 8 Mbps': '1080p, 60 i/s, jusqu’à 8 Mb/s',
    '1440p, 60 fps, up to 20 Mbps': '1440p, 60 i/s, jusqu’à 20 Mb/s',
    'Push to talk: hold {0}. Click to mute.': 'Appuyer pour parler : maintiens {0}. Clique pour couper.',
    'Push to talk: hold your talk key. Click to mute.': 'Appuyer pour parler : maintiens ta touche. Clique pour couper.',
    'Click anywhere to enable call audio.': 'Clique n’importe où pour activer le son de l’appel.',
    "Couldn't share screen: {0}": 'Impossible de partager l’écran : {0}',
    "Couldn't play that file: {0}": 'Impossible de lire ce fichier : {0}',
    "Media file streaming isn't supported here. Use the Miserecord app.": 'La diffusion de fichiers n’est pas possible ici. Utilise l’application Miserecord.',
    'Files can be sent once someone is connected': 'Tu pourras envoyer des fichiers quand quelqu’un sera connecté',
    'Queued': 'En attente',
    'Sent': 'Envoyé',
    'Sent to {0} of {1}': 'Envoyé à {0} sur {1}',
    'Not sent, the connection closed': 'Non envoyé, la connexion s’est fermée',
    'Transfer interrupted': 'Transfert interrompu',
    'Download': 'Télécharger',

    // ---------- screen picker
    'Screens': 'Écrans',
    'Windows': 'Fenêtres',
    'Share computer sound': 'Partager le son de l’ordinateur',
    'Share': 'Partager',
    'Entire screen': 'Écran entier',
    'No screens found.': 'Aucun écran trouvé.',
    'No open windows found.': 'Aucune fenêtre ouverte trouvée.',
    "Couldn't list your screens and windows.": 'Impossible de lister tes écrans et fenêtres.',

    // ---------- settings: general
    'Close settings': 'Fermer les réglages',
    'General': 'Général',
    'Audio': 'Audio',
    'Video': 'Vidéo',
    'Keys': 'Touches',
    'Network': 'Réseau',
    'Appearance': 'Apparence',
    'Auto': 'Auto',
    'Light': 'Clair',
    'Dark': 'Sombre',
    'Language': 'Langue',
    'Saved friends': 'Amis enregistrés',
    'Remove all': 'Tout retirer',
    'No saved friends yet': 'Aucun ami enregistré',
    '1 saved friend': '1 ami enregistré',
    '{0} saved friends': '{0} amis enregistrés',
    "Remove {0}? You'll need to swap codes again to call them.": 'Retirer {0} ? Il faudra rééchanger des codes pour l’appeler.',
    "Remove all {0} saved friends? You'll need to swap codes again to call them.": 'Retirer les {0} amis enregistrés ? Il faudra rééchanger des codes pour les appeler.',
    "Remove all 1 saved friend? You'll need to swap codes again to call them.": 'Retirer l’ami enregistré ? Il faudra rééchanger des codes pour l’appeler.',
    'Friends and your key are kept only on this computer. Removing them means swapping codes again.': 'Tes amis et ta clé sont gardés uniquement sur cet ordinateur. Les retirer oblige à rééchanger des codes.',
    'Running in the background': 'En arrière-plan',
    'Keep running when closed': 'Continuer après la fermeture',
    'Start with Windows': 'Démarrer avec Windows',
    'Friends can only call you while Miserecord is running. Closing the window keeps it in the tray, near the clock. Starting with Windows opens it hidden there.': 'Tes amis ne peuvent t’appeler que si Miserecord est lancé. Fermer la fenêtre le garde dans la zone de notification, près de l’horloge. Démarrer avec Windows l’y ouvre discrètement.',
    'Starting with Windows works in the installed app.': 'Le démarrage avec Windows marche dans l’application installée.',
    'App': 'Application',
    'Version': 'Version',
    '{0} (development)': '{0} (développement)',
    'Updates work in the installed app': 'Les mises à jour marchent dans l’application installée',
    'Check now': 'Vérifier',
    'Checking for updates': 'Recherche de mises à jour',
    'You have the latest version': 'Tu as la dernière version',
    'Downloading update, {0}%': 'Téléchargement de la mise à jour, {0} %',
    'Downloading version {0}': 'Téléchargement de la version {0}',
    'Version {0} is ready': 'La version {0} est prête',
    "Couldn't check for updates": 'Impossible de vérifier les mises à jour',
    'A new version is ready': 'Une nouvelle version est prête',
    'Restart to update': 'Redémarrer pour mettre à jour',
    'Restarting ends your current call. Restart now?': 'Redémarrer met fin à ton appel en cours. Redémarrer maintenant ?',
    'Remove Miserecord from this computer': 'Supprimer Miserecord de cet ordinateur',
    'Uninstall': 'Désinstaller',
    'Uninstall Miserecord?': 'Désinstaller Miserecord ?',
    'This ends your current call.': 'Cela met fin à ton appel en cours.',
    'Also delete my settings, friends and saved data': 'Supprimer aussi mes réglages, amis et données',
    'Your saved friends, settings and logs will be erased. To call your friends again, you would swap codes again.': 'Tes amis enregistrés, réglages et journaux seront effacés. Pour rappeler tes amis, il faudra rééchanger des codes.',
    'Your friends and settings stay on this computer, so they come back if you reinstall.': 'Tes amis et réglages restent sur cet ordinateur et reviennent si tu réinstalles.',
    'Uninstall works in the installed app.': 'La désinstallation marche dans l’application installée.',
    "Couldn't find the uninstaller. Use Windows Settings > Apps instead.": 'Programme de désinstallation introuvable. Passe plutôt par Paramètres Windows > Applications.',
    'Troubleshooting': 'Dépannage',
    'Connection log': 'Journal de connexion',
    'Copy': 'Copier',
    'Clear': 'Effacer',
    "A record of each connection step in this window. It stays on your computer and leaves out IP addresses. If a call won't connect, copy the log from both windows and share it.": 'Un relevé de chaque étape de connexion dans cette fenêtre. Il reste sur ton ordinateur et ne contient pas les adresses IP. Si un appel ne se connecte pas, copie le journal des deux côtés et partage-le.',
    'Log copied': 'Journal copié',
    "Couldn't copy. Use Download instead.": 'Copie impossible. Utilise plutôt Télécharger.',
    'Log cleared': 'Journal effacé',

    // ---------- settings: audio
    'Microphone': 'Micro',
    'Input': 'Entrée',
    'Level': 'Niveau',
    'Test': 'Tester',
    'Stop': 'Arrêter',
    'Echo cancellation': 'Annulation d’écho',
    'Noise suppression': 'Suppression du bruit',
    'Off': 'Désactivée',
    'Standard': 'Standard',
    'AI': 'IA',
    "AI noise suppression is too heavy for this computer, so it's off for this call.": 'La suppression du bruit par IA est trop lourde pour cet ordinateur : elle est coupée pour cet appel.',
    'Automatic volume': 'Volume automatique',
    "Hi-Fi voice is on, so these are off. Use headphones so your friend doesn't hear themselves.": 'La voix Hi-Fi est activée, ces options sont donc coupées. Utilise un casque pour que ton ami ne s’entende pas.',
    'Echo cancellation stops your friend hearing themselves through your speakers. Turn it off only with headphones. AI noise suppression runs a small model on your computer that removes keyboards, fans and background noise and keeps your whole voice.': 'L’annulation d’écho évite que ton ami s’entende dans tes haut-parleurs. Ne la coupe qu’avec un casque. La suppression du bruit par IA fait tourner un petit modèle sur ton ordinateur qui retire le clavier, les ventilateurs et les bruits de fond, sans abîmer ta voix.',
    'Quality': 'Qualité',
    'Voice': 'Voix',
    'Standard, 32 kbps': 'Standard, 32 kb/s',
    'High, 64 kbps': 'Haute, 64 kb/s',
    'Very high, 128 kbps': 'Très haute, 128 kb/s',
    'Hi-Fi stereo, 256 kbps': 'Stéréo Hi-Fi, 256 kb/s',
    'Shared and streamed audio': 'Son partagé et diffusé',
    '128 kbps stereo': '128 kb/s stéréo',
    '256 kbps stereo': '256 kb/s stéréo',
    '510 kbps stereo, best': '510 kb/s stéréo, le meilleur',
    'Hi-Fi turns off echo cancellation and noise suppression so music and voices sound natural. Use headphones with it.': 'La Hi-Fi coupe l’annulation d’écho et la suppression du bruit pour un son naturel. Utilise un casque avec.',
    'Volume': 'Volume',
    "Your friend's voice": 'Voix de tes amis',
    'Streams and shared screens': 'Streams et écrans partagés',
    'Interface sounds': 'Sons de l’interface',
    'Soft sounds for mute, streams and people joining': 'Sons discrets pour le micro, les streams et les arrivées',
    'Sound volume': 'Volume des sons',
    'Play': 'Écouter',
    'Ringtone': 'Sonnerie',
    'Play a ringtone for incoming calls': 'Sonnerie pour les appels entrants',
    'Ringtone volume': 'Volume de la sonnerie',
    'A soft chime that repeats while a friend is calling. Off by default.': 'Un carillon doux qui se répète pendant qu’un ami appelle. Désactivé par défaut.',
    'Output': 'Sortie',
    'Speaker': 'Haut-parleur',
    'System default': 'Par défaut du système',
    "Miserecord plays through your system's default speaker here. Change it in your computer's sound settings.": 'Ici, Miserecord joue le son sur le haut-parleur par défaut. Change-le dans les réglages son de ton ordinateur.',
    "Couldn't use that microphone: {0}": 'Impossible d’utiliser ce micro : {0}',
    "Couldn't open the microphone: {0}": 'Impossible d’ouvrir le micro : {0}',

    // ---------- settings: video
    'Screen sharing': 'Partage d’écran',
    'Resolution': 'Résolution',
    'Full screen resolution': 'Résolution de l’écran',
    'Frame rate': 'Fréquence d’images',
    '30 fps': '30 i/s',
    '60 fps': '60 i/s',
    'Streaming quality': 'Qualité du stream',
    'Bitrate': 'Débit',
    'Automatic, about 2.5 Mbps': 'Automatique, environ 2,5 Mb/s',
    'Low, up to 2.5 Mbps': 'Bas, jusqu’à 2,5 Mb/s',
    'Medium, up to 8 Mbps': 'Moyen, jusqu’à 8 Mb/s',
    'High, up to 20 Mbps': 'Haut, jusqu’à 20 Mb/s',
    'Max, up to 50 Mbps': 'Max, jusqu’à 50 Mb/s',
    'When the connection is busy': 'Quand la connexion sature',
    'Decide for me': 'Choisir pour moi',
    'Balance both': 'Équilibrer les deux',
    'Keep it sharp': 'Garder la netteté',
    'Switched to H.264 for this call: AV1 was too heavy for this computer.': 'Passage en H.264 pour cet appel : l’AV1 était trop lourd pour cet ordinateur.',
    'Keep it smooth': 'Garder la fluidité',
    'Codec': 'Codec',
    'Automatic': 'Automatique',
    'H.264, on the graphics card (smoothest)': 'H.264, sur la carte graphique (le plus fluide)',
    'AV1, sharpest, heavy on the CPU': 'AV1, le plus net, lourd pour le processeur',
    'VP9, on the CPU': 'VP9, sur le processeur',
    'H.264, uses less power': 'H.264, consomme moins',
    'VP8, most compatible': 'VP8, le plus compatible',
    'These are upper limits: on a slower connection the quality drops on its own instead of breaking. 4K at 60 fps looks best at 25 to 50 Mbps of upload. "Decide for me" balances screen shares and keeps videos smooth. Changing the codec also changes it for your friend.': 'Ce sont des plafonds : sur une connexion plus lente, la qualité baisse d’elle-même au lieu de couper. La 4K à 60 i/s rend le mieux avec 25 à 50 Mb/s d’envoi. « Choisir pour moi » équilibre les partages d’écran et garde les vidéos fluides. Changer de codec le change aussi pour ton ami.',
    'Right now': 'En ce moment',
    'Sending': 'Envoi',
    'Receiving': 'Réception',
    'Not in a call': 'Pas en appel',
    'No video': 'Pas de vidéo',
    'limited by CPU': 'limité par le processeur',
    'limited by bandwidth': 'limité par la connexion',
    'limited': 'limité',
    'Your friend set the codec back to automatic': 'Ton ami a remis le codec en automatique',
    'Your friend switched the codec to {0}': 'Ton ami a choisi le codec {0}',
    "Couldn't change the shared screen: {0}": 'Impossible de modifier l’écran partagé : {0}',

    // ---------- settings: keys
    'Push to talk': 'Appuyer pour parler',
    'Use push to talk': 'Utiliser appuyer pour parler',
    'Talk key': 'Touche pour parler',
    'Set key': 'Choisir',
    'Set a talk key': 'Choisis une touche',
    'Press a key': 'Appuie sur une touche',
    'Your microphone only sends while you hold the key. Side mouse buttons work too.': 'Ton micro n’envoie que pendant que tu maintiens la touche. Les boutons latéraux de la souris marchent aussi.',
    'Shortcuts': 'Raccourcis',
    'Mute and unmute': 'Couper et réactiver le micro',
    'Remove shortcut': 'Retirer le raccourci',
    'Remove mute shortcut': 'Retirer le raccourci du micro',
    'Leave call': 'Quitter l’appel',
    'Remove leave shortcut': 'Retirer le raccourci pour quitter',
    'These work everywhere, even while a game or another app is in front.': 'Ils marchent partout, même quand un jeu ou une autre application est au premier plan.',
    'Right now these only work while the Miserecord window is active. In the installed app they work everywhere, even in games.': 'Pour l’instant, ils ne marchent que quand la fenêtre Miserecord est active. Dans l’application installée, ils marchent partout, même en jeu.',
    'Middle click': 'Clic molette',
    'Space': 'Espace',
    'Caps Lock': 'Verr. Maj',
    'Left Ctrl': 'Ctrl gauche',
    'Right Ctrl': 'Ctrl droit',
    'Left Shift': 'Maj gauche',
    'Right Shift': 'Maj droite',
    'Left Alt': 'Alt gauche',
    'Right Alt': 'Alt Gr',

    // ---------- settings: network
    'STUN servers': 'Serveurs STUN',
    'STUN servers, one per line': 'Serveurs STUN, un par ligne',
    'One per line. STUN only tells Miserecord your public address so you and your friend can find each other. Your audio, video and files never pass through it. Clear the box to stay on your local network with no outside servers.': 'Un par ligne. STUN indique seulement ton adresse publique à Miserecord pour que ton ami et toi puissiez vous trouver. Ton son, ta vidéo et tes fichiers n’y passent jamais. Vide la case pour rester sur ton réseau local, sans serveur extérieur.',
    'Relays for calling saved friends': 'Relais pour appeler tes amis enregistrés',
    'Relays, one per line': 'Relais, un par ligne',
    'One per line. Relays only pass encrypted "I\'m calling" messages and connection info between you and a saved friend. They can\'t read them and don\'t store them, but they can see your IP address.': 'Un par ligne. Les relais transmettent seulement des messages chiffrés « je t’appelle » et les infos de connexion entre toi et un ami enregistré. Ils ne peuvent ni les lire ni les garder, mais ils voient ton adresse IP.',
    'Go back to the standard servers and relays': 'Revenir aux serveurs et relais standard',
    'Reset to defaults': 'Réinitialiser',

    // ---------- first launch
    'Welcome to Miserecord': 'Bienvenue sur Miserecord',
    "Choose how you'll talk and listen. You can change all of this later in Settings.": 'Choisis comment tu parles et écoutes. Tu pourras tout changer plus tard dans les Réglages.',
    'Test sound': 'Tester le son',
    'Friends can only call you while Miserecord is running. With this on, it starts quietly in the tray when you sign in.': 'Tes amis ne peuvent t’appeler que si Miserecord est lancé. Avec cette option, il démarre discrètement dans la zone de notification à l’ouverture de ta session.',
    'Done': 'Terminé',
  };

  const DICTS = { fr: FR };
  const NAMES = { en: 'English', fr: 'Français' };
  const ATTRS = ['title', 'aria-label', 'placeholder'];
  const norm = (s) => s.replace(/\s+/g, ' ').trim();

  // Entries with {0}, {1}… become patterns: the parts in braces match anything.
  const patterns = {};
  for (const [lang, dict] of Object.entries(DICTS)) {
    patterns[lang] = Object.keys(dict).filter((k) => /\{\d\}/.test(k)).map((k) => {
      const order = [...k.matchAll(/\{(\d)\}/g)].map((m) => Number(m[1]));
      const re = new RegExp(`^${k.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{\d\}/g, '(.+?)')}$`);
      return { re, order, out: dict[k] };
    });
  }

  let lang = 'en';
  const originals = new WeakMap(); // text node -> its English text
  const originalAttrs = new WeakMap(); // element -> { attr: English }

  function choose(setting) {
    if (setting && setting !== 'auto' && (setting === 'en' || DICTS[setting])) return setting;
    const sys = (navigator.languages && navigator.languages[0]) || navigator.language || 'en';
    return DICTS[sys.slice(0, 2).toLowerCase()] ? sys.slice(0, 2).toLowerCase() : 'en';
  }

  // Translate one English string; unknown text comes back unchanged.
  function t(english, ...args) {
    let s = String(english);
    args.forEach((a, i) => { s = s.replace(`{${i}}`, a); });
    return lookup(s);
  }

  function lookup(s) {
    if (lang === 'en' || !s) return s;
    const dict = DICTS[lang];
    const key = norm(s);
    if (dict[key] !== undefined) return dict[key];
    for (const p of patterns[lang]) {
      const m = key.match(p.re);
      if (m) {
        let out = p.out;
        // The matched parts are names, numbers or messages: they stay as they are.
        p.order.forEach((n, i) => { out = out.replace(`{${n}}`, m[i + 1]); });
        return out;
      }
    }
    return s;
  }

  const skip = (el) => !el || el.closest('[translate="no"], script, style, code');

  function translateText(node) {
    if (skip(node.parentElement)) return;
    const current = node.data;
    // Text the code put in since we last looked is the new English original.
    const known = originals.get(node);
    const english = known && (current === known.fr) ? known.en : current;
    if (!/[A-Za-z]/.test(english)) return;
    const out = lookup(english.trim());
    const lead = english.match(/^\s*/)[0];
    const trail = english.match(/\s*$/)[0];
    const next = out === english.trim() ? english : lead + out + trail;
    originals.set(node, { en: english, fr: next });
    if (node.data !== next) node.data = next;
  }

  function translateAttrs(el) {
    if (skip(el)) return;
    let saved = originalAttrs.get(el);
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      if (!v) continue;
      if (!saved) { saved = {}; originalAttrs.set(el, saved); }
      const prev = saved[a];
      const english = prev && v === prev.fr ? prev.en : v;
      const next = lookup(english);
      saved[a] = { en: english, fr: next };
      if (v !== next) el.setAttribute(a, next);
    }
  }

  function translateTree(root) {
    if (root.nodeType === 3) return translateText(root);
    if (root.nodeType !== 1 && root.nodeType !== 11) return;
    if (root.nodeType === 1) translateAttrs(root);
    const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    for (let n = tw.nextNode(); n; n = tw.nextNode()) {
      if (n.nodeType === 3) translateText(n);
      else {
        translateAttrs(n);
        if (n.tagName === 'TEMPLATE') translateTree(n.content);
      }
    }
  }

  const observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'childList') r.addedNodes.forEach(translateTree);
      else if (r.type === 'characterData') translateText(r.target);
      else if (r.type === 'attributes') translateAttrs(r.target);
    }
    syncPicks();
    // Drop the changes we just made ourselves, or they'd come back here forever.
    observer.takeRecords();
  });

  // The styled dropdowns show a copy of the option text; refresh it.
  function syncPicks() {
    for (const s of document.querySelectorAll('select')) if (s._syncPick) s._syncPick();
  }

  function apply(setting) {
    lang = choose(setting);
    document.documentElement.lang = lang;
    translateTree(document.body);
    document.title = t('Miserecord');
    syncPicks();
    observer.takeRecords();
    if (window.miserecordDesktop && window.miserecordDesktop.setLanguage) window.miserecordDesktop.setLanguage(lang);
  }

  function start(setting) {
    apply(setting);
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }

  return { t, start, apply, current: () => lang, names: NAMES };
})();

// Loaded last, once every screen and dropdown is in place.
I18n.start(settings.language);

