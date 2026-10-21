# Kyara Duel — règles

Copie lisible du livre de règles affiché dans l’onglet « Règles » du mode +Duel (`content/duel-rules.js`). Les deux textes doivent rester identiques ; ils décrivent le moteur `content/duel-engine.js`.

## Sommaire

- [Aperçu](#apercu)
- [Mise en place](#mise-en-place)
- [Manches et initiative](#initiative)
- [Déroulement d’un tour](#tour)
- [Chakra et coûts](#couts)
- [Ciblage](#ciblage)
- [Calcul des dégâts](#degats)
- [Ordre de résolution d’une capacité](#resolution)
- [Effets des capacités](#effets)
- [Statuts](#statuts)
- [Passifs](#passifs)
- [Fin du duel](#fin)
- [Règles en ligne](#en-ligne)
- [Entraînement contre l’IA](#entrainement)

<a id="apercu"></a>

## Aperçu

Kyara Duel oppose deux joueurs dans une arène 5 contre 5. Chaque joueur aligne 5 champions Mythiques distincts ; le but est de mettre KO les 5 champions adverses.

Le duel se joue en manches. À chaque manche, chaque joueur joue un tour, et pendant son tour il fait jouer une seule capacité d’un seul de ses champions (ou il passe).

Deux modes : En ligne, dans un salon à code de 5 lettres, avec des Mythiques de votre collection ; Entraînement contre l’IA, entièrement local, avec n’importe quelles Mythiques.

<a id="mise-en-place"></a>

## Mise en place

Deck : exactement 5 Mythiques différentes. Seules les cartes Mythiques jouent ; les Légendaires et les autres raretés ne sont pas utilisées dans ce mode.

Chaque champion commence avec ses PV pleins, 0 garde, aucun dégât préparé, aucun bonus d’ATQ, aucun statut et son ultime disponible.

Chaque joueur commence avec 1 chakra.

Pour compenser l’avantage d’ouvrir le duel, les 5 champions du camp qui joue en second dans la première manche commencent avec 6 de garde (elle les protège pendant le premier tour adverse).

Tout le hasard du duel (égalité de vitesse, dégâts aléatoires) vient d’une graine tirée au début du duel : la même graine et les mêmes actions donnent toujours le même duel.

<a id="initiative"></a>

## Manches et initiative

Au début de chaque manche, on compare le champion vivant le plus rapide (vitesse) de chaque camp : le camp le plus rapide joue en premier dans cette manche, puis l’autre joue. L’initiative est recalculée à chaque manche : si votre champion le plus rapide tombe, l’adversaire peut prendre la main et jouer deux tours d’affilée (fin d’une manche puis début de la suivante).

Égalité de vitesse : tirage au sort avec la graine du duel.

Subaru Natsuki : tant qu’il est vivant, son camp ouvre toujours la manche, même face à plus rapide. Si les deux camps ont un Subaru vivant, la vitesse décide.

Ram face à Rem : si Ram est dans un camp et Rem vivante dans l’autre, le camp de Ram ouvre la première manche, quoi qu’il arrive (même face à Subaru). Ram est une Légendaire : elle ne joue pas dans cette version, la règle est prête pour plus tard.

<a id="tour"></a>

## Déroulement d’un tour

0. La garde de ses champions s’use : elle disparaît.

1. Le joueur gagne 1 chakra, avec un plafond de 5 (le chakra au-delà du plafond est perdu).

2. Les passifs « au début de son tour » de ses champions vivants se déclenchent, dans l’ordre de son alignement.

3. Il choisit un champion vivant, une de ses 3 capacités, puis une cible si la capacité en demande une. Il peut aussi passer.

Tour sauté : si l’adversaire lui a fait sauter son tour, la garde de ses champions s’use quand même, mais le joueur ne gagne pas de chakra, ses passifs de début de tour ne se déclenchent pas et il ne joue rien ; le tour compte quand même comme un de ses tours (pour les champions empêchés d’attaquer).

Tour supplémentaire (« rejoue ») : le joueur rejoue immédiatement après la capacité, sans nouveau chakra, sans usure de la garde et sans nouveau déclenchement des passifs de début de tour.

<a id="couts"></a>

## Chakra et coûts

Attaque : gratuite (0 chakra).

Soutien : 1 chakra.

Ultime : 4 chakra, et une seule fois par champion et par duel (même s’il est ranimé).

Une capacité dont le coût dépasse votre chakra n’est pas jouable. Le chakra est dépensé même si la capacité est annulée par l’adversaire.

Un champion « empêché d’attaquer » (Titan Colossal d’Armin) ne peut utiliser que son soutien pendant la durée indiquée.

<a id="ciblage"></a>

## Ciblage

Cible ennemie obligatoire si la capacité inflige des dégâts (fixes ou aléatoires), applique un statut à l’adversaire, fait sauter son tour ou peut abattre un champion nommé. Seuls les champions ennemis vivants sont ciblables.

Sinon, si la capacité soigne, donne de la garde ou dissipe, vous choisissez un allié vivant (le lanceur compris) : soin, garde et dissipation s’appliquent à cet allié.

Si la capacité vise un ennemi, ses soins, sa garde et sa dissipation s’appliquent au lanceur.

Les dégâts préparés, les bonus d’ATQ personnels, la perte de PV du lanceur, les statuts sur soi et les protections (annulation, survie, invulnérabilité) concernent toujours le lanceur. Les effets d’équipe touchent tous les alliés vivants.

Une capacité sans dégâts, sans soin, sans garde et sans effet sur l’adversaire (par exemple « +5 ATQ à toute l’équipe ») se joue sans cible.

<a id="degats"></a>

## Calcul des dégâts

Dégâts d’un coup = dégâts de la capacité + ATQ du champion + bonus d’ATQ + dégâts préparés + Rage − Faiblesse + bonus « acculé ». Le résultat ne descend jamais sous 0.

Bonus d’ATQ : cumul des « +ATQ » reçus (capacités et passifs), plafonné à +3 ATQ par champion. Ce bonus est permanent jusqu’au KO.

Dégâts préparés : ils s’accumulent (plafond de 3) et sont tous consommés par la prochaine capacité du champion qui inflige des dégâts (même si la garde adverse les absorbe). Une capacité sans dégâts ne les consomme pas.

Rage : +2 dégâts par coup. Faiblesse : −4 dégâts par coup.

Bonus « acculé » : certaines attaques gagnent un bonus si le lanceur est à 50 % de ses PV max ou moins.

La garde absorbe d’abord les dégâts d’une capacité, le reste retire des PV. Les PV ne descendent jamais sous 0 : à 0 PV, le champion est KO.

Hâte : la prochaine capacité à dégâts frappe deux fois, puis la Hâte disparaît. Le second coup inflige 35 % (arrondi) des dégâts d’un coup normal, Rage et Faiblesse comprises, mais sans les dégâts préparés, qui ne s’ajoutent qu’au premier coup. Si la cible tombe au premier coup, le second est perdu. Une capacité sans dégâts ne consomme pas la Hâte.

Dégâts aléatoires « 6 à 18 » : la valeur de base est tirée avec la graine du duel, à nouveau pour chaque coup.

Une capacité sans dégâts (soutien pur) n’inflige rien, même avec une grosse ATQ.

<a id="resolution"></a>

## Ordre de résolution d’une capacité

1. Le chakra est payé ; un ultime est marqué comme utilisé.

2. Si la cible ennemie annule la prochaine capacité qui la vise, tout s’arrête là : aucun effet, ni sur la cible ni sur le lanceur (pas de contrecoup, dégâts préparés et Hâte conservés).

3. Sacrifice éventuel d’un allié.

4. Sur la cible ennemie : dégâts (un ou deux coups), mise KO d’un champion nommé, statuts infligés, tour sauté, puis passif « quand il touche » du lanceur.

5. Soin, garde et dissipation (allié choisi ou lanceur).

6. Dégâts préparés, bonus d’ATQ (lanceur puis équipe), soins d’équipe, perte de PV des autres alliés, contrecoup du lanceur, statuts sur soi, protections, passif « après un soutien ».

7. Résurrection d’un allié puis chute du lanceur.

8. Tour supplémentaire.

<a id="effets"></a>

## Effets des capacités

Dégâts : voir le calcul des dégâts.

Soin : rend des PV à la cible, sans dépasser ses PV max. Un champion maudit ne reçoit aucun soin.

Soin d’équipe : rend des PV à chaque allié vivant (lanceur compris). Soin total : remet chaque allié vivant à ses PV max.

Garde : s’ajoute à la garde actuelle, plafond de 20. Elle protège jusqu’au prochain tour de son camp : au début de ce tour, elle disparaît. Seuls les dégâts des capacités ennemies l’entament entre-temps.

Dégâts préparés : voir le calcul des dégâts.

+ATQ personnel ou d’équipe : bonus permanent (plafond +3 ATQ par champion), pour le lanceur ou pour chaque allié vivant au moment de l’effet.

« Chaque allié perd N PV » : chaque autre allié vivant perd N PV, sans pouvoir en mourir (minimum 1 PV). La garde ne protège pas de cette perte.

Contrecoup (« il perd / paie N PV ») : le lanceur perd N PV et ne peut pas en mourir (minimum 1 PV). La garde et l’invulnérabilité ne protègent pas de cette perte.

Statut infligé / sur soi : voir les statuts.

Dissipation : retire Poison, Faiblesse et Malédiction de la cible (la Rage, la Régénération et la Hâte restent).

Tour sauté : le joueur adverse saute son prochain tour. Faire sauter un tour déjà sauté ne cumule pas.

Sacrifice : avant l’effet, l’allié vivant ayant le moins de PV (hors lanceur) est mis KO. La capacité n’est pas jouable sans autre allié vivant.

Annulation (« annule la prochaine attaque subie ») : la prochaine capacité ennemie qui vise le lanceur est entièrement annulée. Valable une fois, sans limite de durée.

Survie (« survit au prochain coup létal ») : la prochaine fois que des dégâts devraient mettre le lanceur KO (capacité, poison ou malédiction), il reste à 1 PV. Valable une fois.

Invulnérabilité N : le lanceur ne subit aucun dégât (capacités, poison, malédiction) pendant N manches, celle du lancer comprise. Les statuts peuvent toujours lui être appliqués et il paie toujours ses propres contrecoups.

Empêché d’attaquer N : le lanceur ne peut plus utiliser son attaque ni son ultime pendant ses N prochains tours (le tour du lancer ne compte pas ; les tours sautés comptent).

Abattre un champion nommé : si la cible porte un des noms indiqués (AGR de Gabi : Eren Yeager ou Sasha Blouse), elle est mise KO, en ignorant garde, invulnérabilité et survie.

Résurrection : l’allié tombé le plus récemment revient avec 50 % de ses PV max (arrondi au supérieur), sans garde, sans bonus et sans statut ; son ultime reste utilisé s’il l’avait joué. Puis le lanceur tombe. S’il n’y a aucun allié tombé, personne ne revient et le lanceur reste en jeu.

Rejoue : le joueur joue immédiatement un autre tour (voir le déroulement d’un tour).

<a id="statuts"></a>

## Statuts

Les durées se comptent en manches et diminuent de 1 à la fin de chaque manche. Un statut posé pendant une manche avec une durée de 1 dure donc jusqu’à la fin de cette manche.

Poison N : −1 PV en fin de manche (la garde ne protège pas).

Malédiction N : −1 PV en fin de manche et aucun soin ni régénération reçu.

Faiblesse N : −4 dégâts à chaque coup infligé par le champion.

Rage N : +2 dégâts à chaque coup infligé par le champion.

Régénération N : +4 PV en fin de manche (bloquée par la Malédiction).

Hâte : sans durée ; la prochaine capacité à dégâts frappe deux fois (second coup à 35 %), puis la Hâte disparaît. Une Hâte déjà présente ne se cumule pas.

Réappliquer un statut déjà présent garde la durée la plus longue (pas de cumul).

Fin de manche, dans l’ordre : pour chaque champion vivant (camp qui a ouvert la manche d’abord), poison, puis malédiction, puis régénération ; ensuite toutes les durées baissent de 1 et l’invulnérabilité aussi. Le poison et la malédiction peuvent mettre KO.

Un champion KO perd tous ses statuts, sa garde, ses dégâts préparés et ses bonus.

<a id="passifs"></a>

## Passifs

Chaque Mythique a un passif qui se déclenche tout seul. Le journal indique chaque déclenchement.

« Au début de son tour » : au début de chaque tour joué par le propriétaire du champion (pas pendant un tour sauté, pas lors d’un tour supplémentaire), si le champion est vivant.

« Chaque fois qu’il encaisse » : chaque coup d’une capacité ennemie qui lui inflige au moins 1 dégât, garde comprise (une Hâte = deux déclenchements). Pas pour le poison, la malédiction ni ses propres pertes de PV, et pas s’il tombe sous le coup.

« Quand il touche » / « Ses attaques infligent… » : chaque fois qu’une de ses capacités vise un ennemi sans être annulée ; le statut va sur la cible si elle est encore vivante. Réappliquer garde la durée la plus longue.

« Sous 50 % de PV (une fois) » / « La première fois qu’il passe sous 50 % » : une seule fois par duel, dès que ses PV tombent à 50 % de ses PV max ou moins, quelle qu’en soit la cause (coup, poison, contrecoup…).

« Au début de son tour, sous 50 % de PV » : à chaque début de tour où il est à 50 % de ses PV max ou moins.

Rem : la première fois qu’elle tombe à 12 PV ou moins, elle gagne 7 de garde (une fois par duel).

Roxy Migurdia : après chacun de ses soutiens, elle récupère 2 PV (en plus de l’effet du soutien).

Aqua : chacun de ses soins de capacité (soin et soin d’équipe) rend 1 PV de plus.

Nami : chaque capacité qui vise un ennemi lui inflige aussi Faiblesse 1.

Subaru Natsuki : son camp ouvre toujours la manche tant qu’il est vivant, et il gagne Régénération 2 au début de chacun de ses tours.

« Inflige un statut au début de son tour » (Giyuu, Artoria, Miku, Kyouko, Shouko) : le statut va sur le champion ennemi vivant qui a le plus de PV (à égalité, le premier de l’alignement).

« Dissipe N tours d’un mal » : retire N tours au mal le plus long du champion lui-même (à égalité : Malédiction, puis Poison, puis Faiblesse).

« Donne +N ATQ à toute l’équipe » : chaque allié vivant, lui compris.

« Gagne +N ATQ permanent », garde, Rage, Hâte, Régénération, dégâts préparés, PV : toujours pour le champion lui-même, avec les plafonds habituels. La garde gagnée au début de son tour arrive après l’usure : elle le protège pendant le tour adverse.

Légendaires (hors de cette version, déjà traduites) : Doflamingo inflige Malédiction 1 à chaque capacité qui vise un ennemi ; Ai Hoshino soigne de 2 PV l’allié le plus blessé au début de son tour ; Akane Kurokawa gagne Rage 1 la première fois qu’elle encaisse dans un tour ; Coco retire 1 tour d’un mal au début de son tour ; Sylphiette gagne 1 garde au début de son tour.

<a id="fin"></a>

## Fin du duel

Victoire : les 5 champions adverses sont KO. Si les deux camps tombent en même temps (par exemple sous le poison en fin de manche), le duel est nul.

Limite : après 30 manches, le joueur au plus grand pourcentage de PV restants (somme des PV des champions vivants / somme des PV max de ses 5 champions) gagne. Égalité exacte : match nul.

Abandon : le joueur qui abandonne perd immédiatement.

<a id="en-ligne"></a>

## Règles en ligne

Un joueur crée un salon et communique son code de 5 lettres ; l’autre le rejoint. Le deck doit être complet et composé de Mythiques possédées.

Le serveur arbitre tout : il vérifie chaque action et diffuse l’état. Une action refusée n’a aucun effet.

Délai de tour : 60 secondes. Passé ce délai, le joueur passe automatiquement son tour.

Déconnexion : vous pouvez revenir dans le duel pendant 60 secondes. Au-delà, vous perdez le duel par absence.

Abandonner en ligne compte comme une défaite.

<a id="entrainement"></a>

## Entraînement contre l’IA

Le mode Entraînement se joue entièrement sur votre ordinateur, sans serveur, avec n’importe quelles Mythiques (le deck peut être complété au hasard).

L’IA applique exactement les mêmes règles. Elle cherche le meilleur coup immédiat : achever une cible à portée, lancer un ultime rentable, soigner ou protéger quand c’est utile. Elle ne triche pas sur vos choix futurs mais connaît, comme le moteur, le résultat des dégâts aléatoires du coup qu’elle joue.
