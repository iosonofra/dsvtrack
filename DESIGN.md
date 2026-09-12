# Design direction

## Direction contract

Un control center B2B logistico, sobrio e denso, ispirato al linguaggio operativo DSV. L'interfaccia deve sembrare uno strumento quotidiano: navigazione immediata, ricerca globale sempre disponibile, filtri vicini alla tabella e azioni contestuali solo quando servono.

## Visual system

- Navy `#002b67` per shell, identità e titoli.
- Blu `#064bc4` per azioni primarie, selezione e focus.
- Verde, ambra e rosso esclusivamente per stati semantici.
- Sfondo grigio chiaro, superfici bianche, bordi sottili, raggi di 2–3 px e ombre minime.
- Tipografia di sistema compatta, con numeri tabulari nei KPI e nelle date.
- Tabelle con intestazione sticky, righe da circa 50 px, zebra molto leggera e hover esplicito.

## Interaction rules

- Sidebar comprimibile su desktop e drawer su mobile.
- Ricerca globale trasferisce la query al centro di controllo.
- Selezione multipla apre una toolbar contestuale.
- Dettaglio spedizione in drawer laterale, chiudibile con Escape e con ripristino del focus.
- Gli stati combinano etichetta, colore e indicatore grafico.

## Responsive behavior

- Desktop: sidebar persistente e superficie dati a piena larghezza.
- Tablet: sidebar drawer, filtri su due colonne e tabella orizzontalmente scrollabile.
- Mobile: KPI 2×2, filtri impilati, bulk action avvolgibili e dettaglio a tutto schermo.
