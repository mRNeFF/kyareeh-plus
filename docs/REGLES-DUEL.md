# Kyara Duel — règles

Copie lisible du livre de règles affiché dans l’onglet « Règles » du mode +Duel (`content/duel-rules.js`). Les deux textes doivent rester identiques ; ils décrivent le moteur v2 `content/duel-engine.js` (combat 1 contre 1, banc de 4, choix simultanés).

## Sommaire

- [Aperçu](#apercu)
- [Équipe et banc](#equipe)
- [Déroulement d’un tour](#tour)
- [Choix simultanés et secrets](#choix)
- [Ordre de résolution du tour](#resolution-tour)
- [Changements et remplacement après un K.O.](#changements)
- [Chakra et coûts](#couts)
- [Types et efficacité](#types)
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

Kyara Duel oppose deux joueurs dans un combat 1 contre 1. Chaque joueur aligne une équipe de 5 champions (Mythiques ou Légendaires), mais un seul champion par camp est « actif » à la fois : il combat. Les 4 autres attendent sur le banc.

À chaque tour, les deux joueurs choisissent EN SECRET et EN MÊME TEMPS une action : utiliser une capacité de leur champion actif, changer de champion, ou passer. Les deux actions sont ensuite résolues dans un ordre fixé par les règles : les changements d’abord, puis les capacités, du champion le plus rapide au plus lent.

Quand un champion actif tombe KO, son joueur envoie un remplaçant du banc. Le but du duel : mettre KO les 5 champions adverses.

Deux modes : En ligne, dans un salon à code de 5 lettres, avec des cartes de votre collection ; Entraînement contre l’IA, entièrement local, avec n’importe quelles cartes jouables.

<a id="equipe"></a>

## Équipe et banc

Deck : exactement 5 champions différents, Mythiques ou Légendaires, mélangés librement. La rareté ne donne aucun avantage : les deux sont équilibrées ensemble. Les autres raretés ne sont pas utilisées dans ce mode.

L’ordre du deck compte : le premier champion est envoyé au combat par chaque joueur au début du duel, les 4 autres forment le banc. Choisissez bien votre champion de tête.

Chaque champion commence avec ses PV pleins, 0 garde, aucun dégât préparé, aucun bonus d’ATQ, aucun statut et son ultime disponible. Chaque joueur commence avec 1 chakra.

Un champion sur le banc garde tout ce qu’il avait : PV, garde, bonus d’ATQ, dégâts préparés, ultime déjà utilisé, protections et statuts. Rien ne se « remet à zéro » en changeant de champion.

Ce qui se passe sur le banc : les durées des statuts continuent de baisser, mais le poison, la malédiction et la régénération n’y font rien (ils n’agissent que sur le champion actif) ; la garde du banc ne s’use pas ; les passifs « au début de son tour » ne jouent que pour le champion actif.

Les effets d’équipe (« +ATQ à toute l’équipe », soin d’équipe, soin total, « chaque allié perd N PV ») touchent tous les champions vivants du camp, banc compris. Les soutiens à cible alliée (soin, garde, dissipation) peuvent viser un champion du banc : c’est tout l’intérêt tactique du banc.

Tout le hasard du duel (égalité de vitesse, dégâts aléatoires) vient d’une graine tirée au début du duel : la même graine et les mêmes choix donnent toujours le même duel.

<a id="tour"></a>

## Déroulement d’un tour

1. Début de tour : la garde de chaque champion actif s’use (elle disparaît) ; les deux joueurs gagnent 1 chakra (plafond de 5, le surplus est perdu) ; les passifs « au début de son tour » des deux champions actifs se déclenchent.

2. Choix : les deux joueurs choisissent en secret et en même temps.

3. Résolution : changements, puis capacités et « passer » dans l’ordre d’action (voir plus bas) ; le champion qui agit en second se met d’abord en garde.

4. Action bonus éventuelle (capacité « rejoue ») : le joueur concerné rejoue immédiatement une action, sans nouveau chakra ni nouvelle usure de garde, avant la fin du tour.

5. Fin de tour : poison, malédiction et régénération des champions actifs, épuisement éventuel, baisse des durées des statuts de tous les champions, puis vérification de la fin du duel.

6. Si un champion actif est KO, phase de remplacement ; sinon le tour suivant commence.

<a id="choix"></a>

## Choix simultanés et secrets

Trois sortes d’actions : une capacité de votre champion actif (avec sa cible si elle en demande une), un changement de champion, ou passer. Passer est toujours possible ; c’est aussi l’action par défaut quand le délai de choix expire en ligne.

Votre choix reste secret jusqu’à la résolution : votre adversaire sait seulement si vous avez choisi ou non, jamais quoi. Une action illégale (capacité indisponible, chakra insuffisant, cible ou changement invalide) est refusée et n’a aucun effet.

Action perdue : si l’adversaire vous a fait « sauter » votre action (voir les effets), la seule action possible est passer ; elle est consommée à la place de votre choix.

<a id="resolution-tour"></a>

## Ordre de résolution du tour

D’abord les changements des deux camps. Ensuite, les capacités et les « passer », dans l’ordre d’action : le champion actif le plus rapide (vitesse) agit en premier. La vitesse retenue est celle du champion qui sera actif au moment d’agir : un remplaçant qui vient d’entrer compte avec sa propre vitesse.

Égalité de vitesse : tirage au sort avec la graine du duel (l’ordre du tour est affiché dans le journal).

Priorités tirées des données : Subaru Natsuki, tant qu’il est le champion actif, fait agir son camp en premier, même face à plus rapide ; si les deux camps ont un Subaru actif, la vitesse décide. Ram face à Rem : si Ram est active face à Rem au premier tour, son camp agit en premier, quoi qu’il arrive (même face à Subaru) ; Ram est une Légendaire, elle ne joue pas dans cette version, la règle est prête pour plus tard.

Nouvelle cible : si votre capacité vise l’adversaire et que celui-ci a changé de champion avant qu’elle ne soit résolue, elle frappe le NOUVEL actif (le journal l’indique). Si la cible a disparu (déjà KO ce tour-ci), la capacité échoue et rien n’est dépensé.

Un champion KO ne joue plus : s’il est mis KO avant d’avoir agi, sa capacité choisie est annulée (le journal l’annonce), sans dépense de chakra, sans effet, sans Hâte consommée ni action bonus. Cela vaut aussi pour les actions bonus (capacité « rejoue ») : un champion abattu entre-temps ne rejoue pas, et celui qui était censé rejouer mais tombe avant ne gagne rien. Frapper le premier peut donc éliminer l’adversaire avant qu’il ne réplique : c’est pourquoi le plus lent est protégé (règle suivante).

Agir en second : le champion qui agit en second (parce qu’il est plus lent, qu’il a perdu l’égalité de vitesse tirée au sort, ou face à la priorité de Subaru) se met en garde avant que le premier ne frappe : il gagne 5 garde, à condition d’avoir choisi une capacité (attaque, soutien ou ultime) ; pas s’il passe ou change de champion. La garde habituelle s’applique (plafond, usure au début du tour suivant) et le journal l’annonce. Ainsi, être plus rapide donne l’initiative mais pas la victoire.

Les changements ne dépendent pas de la vitesse, sauf pour décider de l’ordre quand les deux camps changent ; ils ont tous lieu avant la moindre capacité.

<a id="changements"></a>

## Changements et remplacement après un K.O.

Changer de champion : vous rappelez votre champion actif et envoyez à sa place un champion vivant du banc. Le changement est gratuit (0 chakra) mais il utilise votre action du tour. Le champion rappelé garde son état tel quel.

Un champion peut être rappelé avant d’avoir été touché : le champion qui entre encaisse alors la capacité que l’adversaire destinait à l’ancien actif. C’est la manœuvre classique pour s’abriter d’un mauvais rapport de force ou d’un coup fatal.

Remplacement : quand votre champion actif est KO, la phase de remplacement a lieu après la fin du tour. Vous choisissez un remplaçant vivant du banc. Elle est gratuite et ne consomme aucun tour de jeu. Si les deux champions actifs sont KO, les deux joueurs choisissent en même temps, en secret.

Entrée en jeu : un champion qui entre (changement ou remplacement) peut déclencher un passif « à l’entrée en jeu ».

Si vous n’avez plus aucun champion vivant, vous avez perdu : il n’y a pas de remplacement.

<a id="couts"></a>

## Chakra et coûts

Chaque joueur gagne 1 chakra au début de chaque tour, avec un plafond de 5. Le chakra est commun à toute l’équipe : il ne dépend pas du champion actif.

Attaque : gratuite (0 chakra).

Soutien : 1 chakra.

Ultime : 4 chakra, et une seule fois par champion et par duel (même s’il est ranimé, même s’il revient du banc).

Changer de champion : 0 chakra (gratuit), mais cela prend l’action du tour.

Une capacité dont le coût dépasse votre chakra n’est pas jouable. Le chakra est dépensé même si la capacité est annulée par l’adversaire.

Un champion « empêché d’attaquer » (Titan Colossal d’Armin) ne peut utiliser que son soutien pendant la durée indiquée ; il peut toujours changer de champion ou passer.

<a id="types"></a>

## Types et efficacité

Le type d’un champion est son rôle : Duelliste (rouge, #ff5a4e), Mystique (violet, #a66bff), Soutien (vert, #3fd68a), Gardien (bleu, #4aa3ff), Stratège (jaune, #ffc24a). Gardienne compte comme Gardien. La couleur du type habille les effets du combat.

Triangle principal : Duelliste bat Mystique, Mystique bat Gardien, Gardien bat Duelliste. Une capacité qui frappe un type qu’elle bat inflige ×1,25 dégâts ; contre le type qui la bat, ×0,8.

Petit duel : Stratège bat Soutien : ×1,15 dans ce sens, ×0,9 dans l’autre. Tous les autres couples sont neutres (×1).

L’efficacité s’applique uniquement aux dégâts des capacités (pas au poison, à la malédiction, à l’épuisement ni aux pertes de PV des effets), à chaque coup, après tous les bonus et malus, avec arrondi à l’entier le plus proche. Le journal annonce « C’est efficace » ou « Ce n’est pas très efficace ».

Le type pris en compte est celui du champion qui reçoit réellement le coup (après un éventuel changement).

<a id="ciblage"></a>

## Ciblage

Cible ennemie : toujours le champion actif adverse. Elle est obligatoire si la capacité inflige des dégâts (fixes ou aléatoires), applique un statut à l’adversaire, lui fait perdre son action ou peut abattre un champion nommé.

Sinon, si la capacité soigne, donne de la garde ou dissipe, vous choisissez un allié vivant (le lanceur compris, banc compris) : soin, garde et dissipation s’appliquent à cet allié.

Si la capacité vise l’ennemi, ses soins, sa garde et sa dissipation s’appliquent au lanceur.

Les dégâts préparés, les bonus d’ATQ personnels, la perte de PV du lanceur, les statuts sur soi et les protections (annulation, survie, invulnérabilité) concernent toujours le lanceur. Les effets d’équipe touchent tous les alliés vivants, banc compris.

Une capacité sans dégâts, sans soin, sans garde et sans effet sur l’adversaire (par exemple « +5 ATQ à toute l’équipe ») se joue sans cible.

<a id="degats"></a>

## Calcul des dégâts

Dégâts d’un coup = (dégâts de la capacité + ATQ du champion + bonus d’ATQ + dégâts préparés + Rage − Faiblesse + bonus « acculé ») × efficacité de type. Le résultat ne descend jamais sous 0.

Bonus d’ATQ : cumul des « +ATQ » reçus (capacités et passifs), plafonné à +3 ATQ par champion. Ce bonus est permanent jusqu’au KO.

Dégâts préparés : ils s’accumulent (plafond de 3) et sont tous consommés par la prochaine capacité du champion qui inflige des dégâts (même si la garde adverse les absorbe). Une capacité sans dégâts ne les consomme pas.

Rage : +2 dégâts par coup. Faiblesse : −4 dégâts par coup.

Bonus « acculé » : certaines attaques gagnent un bonus si le lanceur est à 50 % de ses PV max ou moins.

La garde absorbe d’abord les dégâts d’une capacité, le reste retire des PV. Les PV ne descendent jamais sous 0 : à 0 PV, le champion est KO.

Hâte : la prochaine capacité à dégâts frappe deux fois, puis la Hâte disparaît. Le second coup inflige 35 % (arrondi) des dégâts d’un premier coup, efficacité de type comprise, mais sans les dégâts préparés, qui ne s’ajoutent qu’au premier coup. Si la cible tombe au premier coup, le second est perdu. Une capacité sans dégâts ne consomme pas la Hâte.

Dégâts aléatoires « 6 à 18 » : la valeur de base est tirée avec la graine du duel, à nouveau pour chaque coup.

Une capacité sans dégâts (soutien pur) n’inflige rien, même avec une grosse ATQ.

<a id="resolution"></a>

## Ordre de résolution d’une capacité

1. Le chakra est payé ; un ultime est marqué comme utilisé.

2. Si la cible ennemie annule la prochaine capacité qui la vise, tout s’arrête là : aucun effet, ni sur la cible ni sur le lanceur (pas de contrecoup, dégâts préparés et Hâte conservés).

3. Sacrifice éventuel d’un allié du banc.

4. Sur la cible ennemie : annonce de l’efficacité de type, dégâts (un ou deux coups), mise KO d’un champion nommé, statuts infligés, action perdue, puis passif « quand il touche » du lanceur.

5. Soin, garde et dissipation (allié choisi ou lanceur).

6. Dégâts préparés, bonus d’ATQ (lanceur puis équipe), soins d’équipe, perte de PV des autres alliés, contrecoup du lanceur, statuts sur soi, protections, passif « après un soutien ».

7. Résurrection d’un allié puis chute du lanceur.

8. Action bonus en fin de tour (« rejoue »).

<a id="effets"></a>

## Effets des capacités

Dégâts : voir le calcul des dégâts.

Soin : rend des PV à la cible, sans dépasser ses PV max. Un champion maudit ne reçoit aucun soin.

Soin d’équipe : rend des PV à chaque allié vivant, banc compris (lanceur compris). Soin total : remet chaque allié vivant à ses PV max.

Garde : s’ajoute à la garde actuelle, plafond de 20. Elle protège contre les dégâts des capacités : à chaque début de tour, la garde du champion actif s’use — elle disparaît. Une garde posée sur un allié du banc ne s’use pas tant qu’il n’est pas entré en jeu : on peut donc protéger d’avance un champion avant de l’envoyer au combat.

Dégâts préparés : voir le calcul des dégâts.

+ATQ personnel ou d’équipe : bonus permanent (plafond +3 ATQ par champion), pour le lanceur ou pour chaque allié vivant, banc compris, au moment de l’effet.

« Chaque allié perd N PV » : chaque autre allié vivant (donc le banc) perd N PV, sans pouvoir en mourir (minimum 1 PV). La garde ne protège pas de cette perte.

Contrecoup (« il perd / paie N PV ») : le lanceur perd N PV et ne peut pas en mourir (minimum 1 PV). La garde et l’invulnérabilité ne protègent pas de cette perte.

Statut infligé / sur soi : voir les statuts.

Dissipation : retire Poison, Faiblesse et Malédiction de la cible (la Rage, la Régénération et la Hâte restent).

Action perdue (« l’adversaire saute son tour ») : si l’adversaire n’a pas encore agi ce tour-ci (il est plus lent et n’a pas changé de champion), il perd l’action qu’il avait choisie, tout de suite. Sinon, il perd son action du tour suivant : elle est remplacée par « passer ». Cela ne cumule pas.

Sacrifice : avant l’effet, l’allié vivant ayant le moins de PV (forcément sur le banc) est mis KO. La capacité n’est pas jouable sans autre allié vivant.

Annulation (« annule la prochaine attaque subie ») : la prochaine capacité ennemie qui vise le lanceur est entièrement annulée. Valable une fois, sans limite de durée, même si le lanceur passe sur le banc entre-temps.

Survie (« survit au prochain coup létal ») : la prochaine fois que des dégâts devraient mettre le lanceur KO (capacité, poison, malédiction ou épuisement), il reste à 1 PV. Valable une fois.

Invulnérabilité N : le lanceur ne subit aucun dégât (capacités, poison, malédiction, épuisement) pendant N tours, celui du lancer compris. Les statuts peuvent toujours lui être appliqués et il paie toujours ses propres contrecoups. Le décompte continue même sur le banc.

Empêché d’attaquer N : le lanceur ne peut plus utiliser son attaque ni son ultime pendant les N tours suivants (le tour du lancer ne compte pas).

Abattre un champion nommé : si la cible porte un des noms indiqués (AGR de Gabi : Eren Yeager ou Sasha Blouse), elle est mise KO, en ignorant garde, invulnérabilité et survie.

Résurrection : l’allié tombé le plus récemment revient sur le banc avec 50 % de ses PV max (arrondi au supérieur), sans garde, sans bonus et sans statut ; son ultime reste utilisé s’il l’avait joué. Puis le lanceur tombe (et son joueur choisit un remplaçant, le ressuscité compris). S’il n’y a aucun allié tombé, personne ne revient et le lanceur reste en jeu.

Rejoue : une action bonus avant la fin du tour (voir le déroulement d’un tour).

<a id="statuts"></a>

## Statuts

Les durées se comptent en tours et diminuent de 1 à la fin de chaque tour, pour tous les champions vivants (banc compris). Un statut posé pendant un tour avec une durée de 1 dure donc jusqu’à la fin de ce tour.

Poison N : −1 PV en fin de tour (la garde ne protège pas), si le champion est actif.

Malédiction N : −1 PV en fin de tour (si actif) et aucun soin ni régénération reçu.

Faiblesse N : −4 dégâts à chaque coup infligé par le champion.

Rage N : +2 dégâts à chaque coup infligé par le champion.

Régénération N : +4 PV en fin de tour, si le champion est actif (bloquée par la Malédiction).

Hâte : sans durée ; la prochaine capacité à dégâts frappe deux fois (second coup à 35 %), puis la Hâte disparaît. Une Hâte déjà présente ne se cumule pas.

Réappliquer un statut déjà présent garde la durée la plus longue (pas de cumul).

Fin de tour, dans l’ordre : pour chaque champion actif (le camp qui a agi le premier d’abord), poison, puis malédiction, puis régénération ; puis l’épuisement s’il est en vigueur ; ensuite toutes les durées baissent de 1 et l’invulnérabilité aussi. Le poison, la malédiction et l’épuisement peuvent mettre KO.

Un champion KO perd tous ses statuts, sa garde, ses dégâts préparés et ses bonus.

<a id="passifs"></a>

## Passifs

Chaque champion a un passif qui se déclenche tout seul. Le journal indique chaque déclenchement. Les passifs de début de tour ne jouent que pour le champion actif ; ceux qui réagissent à un coup (« quand il encaisse », « quand il touche ») ne jouent que pendant qu’il est au combat.

« Au début de son tour » : au début de chaque tour, pour le champion actif vivant (pas sur le banc, pas lors d’une action bonus).

« Chaque fois qu’il encaisse » : chaque coup d’une capacité ennemie qui lui inflige au moins 1 dégât, garde comprise (une Hâte = deux déclenchements). Pas pour le poison, la malédiction, l’épuisement ni ses propres pertes de PV, et pas s’il tombe sous le coup.

« Quand il touche » / « Ses attaques infligent… » : chaque fois qu’une de ses capacités vise un ennemi sans être annulée ; le statut va sur la cible si elle est encore vivante. Réappliquer garde la durée la plus longue.

« Sous 50 % de PV (une fois) » / « La première fois qu’il passe sous 50 % » : une seule fois par duel, dès que ses PV tombent à 50 % de ses PV max ou moins, quelle qu’en soit la cause (coup, poison, contrecoup…). Un passif de ce type peut se déclencher même si le champion est sur le banc (par exemple à cause d’un « chaque allié perd N PV »).

« Au début de son tour, sous 50 % de PV » : à chaque début de tour où il est actif et à 50 % de ses PV max ou moins.

« À l’entrée en jeu » : quand le champion entre au combat (changement ou remplacement). Aucune carte actuelle n’en a besoin, mais la règle existe.

Rem : la première fois qu’elle tombe à 12 PV ou moins, elle gagne 7 de garde (une fois par duel).

Roxy Migurdia : après chacun de ses soutiens, elle récupère 2 PV (en plus de l’effet du soutien).

Aqua : chacun de ses soins de capacité (soin et soin d’équipe) rend 1 PV de plus.

Nami : chaque capacité qui vise un ennemi lui inflige aussi Faiblesse 1.

Subaru Natsuki : tant qu’il est le champion actif, son camp agit toujours en premier, et il gagne Régénération 2 au début de chacun de ses tours.

« Inflige un statut au début de son tour » (Giyuu, Artoria, Miku, Kyouko, Shouko) : le statut va sur le champion actif adverse.

« Dissipe N tours d’un mal » : retire N tours au mal le plus long du champion lui-même (à égalité : Malédiction, puis Poison, puis Faiblesse).

« Donne +N ATQ à toute l’équipe » : chaque allié vivant, lui compris, banc compris.

« Gagne +N ATQ permanent », garde, Rage, Hâte, Régénération, dégâts préparés, PV : toujours pour le champion lui-même, avec les plafonds habituels. La garde gagnée au début de son tour arrive après l’usure : elle le protège pendant le tour qui commence.

Légendaires (hors de cette version, déjà traduites) : Doflamingo inflige Malédiction 1 à chaque capacité qui vise un ennemi ; Ai Hoshino soigne de 2 PV l’allié le plus blessé au début de son tour ; Akane Kurokawa gagne Rage 1 la première fois qu’elle encaisse dans un tour ; Coco retire 1 tour d’un mal au début de son tour ; Sylphiette gagne 1 garde au début de son tour.

<a id="fin"></a>

## Fin du duel

Victoire : les 5 champions adverses sont KO. Si les deux camps tombent en même temps (par exemple sous le poison en fin de tour, ou par l’épuisement), le duel est nul.

Épuisement : à partir du tour 18, à la fin de chaque tour, les deux champions actifs perdent 3 PV, puis 6 PV au tour suivant, 9 PV… Ni la garde ni les soins ne tiennent bien longtemps : les duels qui s’enlisent se terminent. L’épuisement respecte l’invulnérabilité et la survie.

Limite : après 40 tours, le joueur au plus grand pourcentage de PV restants (somme des PV des champions vivants / somme des PV max de ses 5 champions) gagne. Égalité exacte : match nul. En pratique, l’épuisement met fin au duel bien avant.

Abandon : le joueur qui abandonne perd immédiatement.

<a id="en-ligne"></a>

## Règles en ligne

Un joueur crée un salon et communique son code de 5 lettres ; l’autre le rejoint. Le deck doit être complet et composé de cartes possédées (Mythiques ou Légendaires).

Le serveur arbitre tout : il vérifie chaque action et diffuse l’état. Il ne révèle jamais votre choix à l’adversaire avant la résolution. Une action refusée n’a aucun effet.

Délai de choix : 45 secondes. Passé ce délai, le joueur qui n’a pas choisi passe automatiquement.

Délai de remplacement : 20 secondes. Passé ce délai, le premier remplaçant vivant du banc est envoyé automatiquement.

3 délais expirés d’affilée font perdre le duel par absence.

Déconnexion : vous pouvez revenir dans le duel pendant 60 secondes. Au-delà, vous perdez le duel par absence.

Abandonner en ligne compte comme une défaite.

<a id="entrainement"></a>

## Entraînement contre l’IA

Le mode Entraînement se joue entièrement sur votre ordinateur, sans serveur, avec n’importe quelles Mythiques ou Légendaires (le deck peut être complété au hasard).

L’IA applique exactement les mêmes règles. Elle devine votre coup le plus probable, simule chacune de ses actions contre ce coup et contre votre meilleure attaque, et change de champion quand le rapport de force (type, vitesse, PV, menace de KO) l’exige. Après un KO, elle choisit son remplaçant d’après les mêmes critères.

Elle ne lit jamais votre choix secret du tour en cours et ne connaît pas le hasard à venir.
