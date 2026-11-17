# Förbättringsplan – Antonias dagbok

Beslutad 2026-11-17 efter genomgång (grill-me). Varje fas blir en egen PR.

## Bakgrund

- Antonia har PMDS och PCOS. PCOS ger oregelbunden mens, så kalendern kan inte
  förutsäga när en tung period kommer. Appen ska hitta tidiga tecken så att hon
  vet när hon ska börja en omgång escitalopram.
- Hon tar p-piller kontinuerligt och gör ibland uppehåll för att blöda ut.
- Hon har precis fått appen. Viktigast nu: att det blir en daglig vana med så
  lite ansträngning som möjligt.
- Hon vet och tycker det är okej att Lucas ser partneröversikten.

## Principer

- Loggning ska ta ~10 sekunder en dålig dag.
- Ingen skuld: inga streaks, inget rött för missade dagar, "Välkommen tillbaka 💗".
- Hennes egna ord behålls (skalor och snabbval byts inte ut).
- Lucas fyller aldrig i åt henne (valt bort – kan kännas som övervakning).
- Ingen påminnelse till Lucas om att hon inte loggat.

---

## Fas 1 – Daglig vana

1. **Snabbloggning på Idag** med fyra skalor: Humör, Ångest / oro,
   Irritabilitet, Magbesvär. Varje tryck sparas direkt (ingen Spara-knapp).
   När alla fyra är ifyllda: "Klart för idag 💗 Orkar du så kan du fylla i mer –
   det gör mönstren tydligare" + länk till fullständiga Mående.
2. **Ny ordning på Idag:** hälsning → "Känner du igen det här?" (om finns) →
   stödkort (tung dag) → snabbloggning → medicinkort (behålls, även utan omgång)
   → diskreta rader: 🩸 Blödning · 🚫 Undvik · 💗 Stöd.
3. **Tung dag-regeln** (`isHeavyDay`) bygger på snabblägets skalor (humör,
   ångest, irritabilitet) i stället för självkritik. Nivåberäkningar och
   partnerns `areas7` ska tåla luckor: tomt = "ingen data", aldrig "bra".
4. **Push:** Lucas gör uppsättningen enligt `supabase/NOTISER-UPPSATTNING.md`
   (VAPID, Edge Function, schema). Appen får egna tider i Inställningar:
   kvällspåminnelse (standard 21:00) och tablettpåminnelse (standard 09:00,
   bara under aktiv omgång). Högst en notis av varje sort per dag. Mjuk text,
   t.ex. "Hur har dagen varit? Det tar 10 sekunder 💗". Klick öppnar Idag.
   Kräver att `daglig-koll` läser hennes valda tider i stället för fasta fönster.
5. **Intro första gången** (två kort, går att hoppa över): (1) varför – några
   tryck per dag räcker för att se mönster över tid; (2) slå på notiser och
   välj tider.
6. **Mörkt läge** som följer iPhonens inställning (varm mörk plommon, dämpade
   rosa accenter, egna nivåfärger), samt **bättre kontrast** i ljust läge
   (dämpad text och accent minst 4,5:1).
7. **Ingen skuld:** "Välkommen tillbaka 💗" efter uppehåll i loggningen.

## Fas 2 – Hitta PMDS-mönstren

1. **Uppehåll i p-piller:** knapp "Jag gör uppehåll" → "Uppehåll pågår – dag N"
   + "Började igen". I p-pillerkortet i Medicin och som diskret rad på Idag.
   Sparas i `notes` (som kartstarterna). Syns i Mönster-kalendern och i
   läkarrapporten.
2. **Bortfallsblödning** som egen blödningstyp, föreslås under/efter uppehåll.
3. **AI-kollen** får även blödningar, kartstarter och uppehåll. Systemprompten
   skrivs om så att den kan jämföra med "dagarna efter ett uppehåll" och
   blödningar, inte bara tidigare omgångsstarter.
4. **Mönster bantas:** kalender överst → insiktskort "Det här syns just nu"
   (1–3 meningar, annars "Inget tydligt mönster än – fortsätt logga 💗") →
   fällbart "Mer statistik" (månadsrutor, medicineffekt, månadsöversikt,
   snabbval, jämförelser) → läkarrapport.
5. **Minsta data-regel:** jämförande statistik visas först vid ~14 loggade dagar
   ("Visas när du loggat 14 dagar (9 kvar)").
6. **ⓘ-förklaringar** vid statistiken.

## Fas 3 – Stöd och lärande

1. **Guide "Så funkar appen"** i Inställningar, fällbara avsnitt: Logga en dag,
   Medicin och omgångar, Blödningar och uppehåll, Hur Mönster räknar,
   AI-kollen, Säkerhetskopiering.
2. **Förbättringar/feedback:** textfält + Skicka i Inställningar. Egen tabell
   `feedback` på servern (köas offline). Kortet "Förslag från Antonia" i
   Lucas app med "Klar"-knapp; hon ser sina förslag och "✓ Fixat".
3. **Dela "Det här hjälper mig" med Lucas:** opt-in, av som standard. Valfri
   separat text bara till honom. Visas i partnervyn under tyngre period som
   "Det här brukar hjälpa henne". Nytt fält i `partner_overview()`, fylls bara
   när delning är på. Inget annat från anteckningar delas.
4. **Egna snabbval:** dölja befintliga och lägga till egna i Inställningar
   (data för dolda finns kvar; id:n ändras aldrig).

## Fas 4 – Fråga din dagbok (efter 1–2 månaders data)

1. I Mönster: **"Fråga din dagbok"** med färdiga frågeknappar, t.ex.
   "Sammanfatta senaste månaden", "Vad hände förra gången efter uppehåll?",
   "Inför läkarbesöket". Ett klick startar chatten med frågan; därefter kan hon
   fortsätta i fritext.
2. Ny Edge Function som proxy (API-nyckeln stannar på servern), Claude Sonnet
   5.5, dagboken cachad per chatt. Uppskattad kostnad ~1,5 $/mån vid normal
   användning.
3. Säkerhet: inga doseringsråd, ingen diagnos, ersätter inte läkaren. Vid
   tecken på att hon mår mycket dåligt hänvisar den till **1177**.
4. Kräver nät; visar ett vänligt meddelande offline.

---

## Kvar att göra utanför koden

- Lucas: sätt upp push (VAPID-nycklar, Edge Function, schema).
- Lägg gärna in tidigare escitalopram-omgångar bakåt, så AI-kollen har något
  att jämföra med från början.
- Fråga Antonia hur hon gör med p-pillren (bekräfta: kontinuerligt + ibland
  uppehåll).
