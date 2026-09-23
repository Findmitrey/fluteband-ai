// FluteBand AI — эталонные MusicXML-страницы для проверки тракта «распознавание → минус» без сервера.

/** Бетховен, «Ода к радости»: 4 такта, D-dur, 4/4, Andante, с аккордовыми символами */
export const ODE_TO_JOY_MUSICXML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <work><work-title>Ода к радости (фрагмент)</work-title></work>
  <identification><creator type="composer">Л. ван Бетховен</creator></identification>
  <part-list><score-part id="P1"><part-name>Melody</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>4</divisions>
        <key><fifths>2</fifths><mode>major</mode></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
      </attributes>
      <direction><direction-type><words>Andante</words></direction-type></direction>
      <harmony><root><root-step>D</root-step></root><kind value="major">major</kind></harmony>
      <note><pitch><step>F</step><alter>1</alter><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
      <note><pitch><step>F</step><alter>1</alter><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
      <note><pitch><step>A</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
    </measure>
    <measure number="2">
      <harmony><root><root-step>A</root-step></root><kind value="dominant">dominant</kind></harmony>
      <note><pitch><step>A</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
      <note><pitch><step>F</step><alter>1</alter><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
    </measure>
    <measure number="3">
      <harmony><root><root-step>D</root-step></root><kind value="major">major</kind></harmony>
      <note><pitch><step>D</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
      <note><pitch><step>D</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
      <note><pitch><step>F</step><alter>1</alter><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
    </measure>
    <measure number="4">
      <harmony><root><root-step>A</root-step></root><kind value="dominant">dominant</kind></harmony>
      <note><pitch><step>F</step><alter>1</alter><octave>4</octave></pitch><duration>6</duration><voice>1</voice><type>quarter</type><dot/></note>
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><type>eighth</type></note>
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>8</duration><voice>1</voice><type>half</type></note>
    </measure>
  </part>
</score-partwise>`;

/** Двухголосный такт: мелодия в верхнем голосе, бас в нижнем (проверка <backup> и классификации голосов) */
export const TWO_VOICE_MUSICXML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <work><work-title>Двухголосие</work-title></work>
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>2</divisions>
        <key><fifths>0</fifths><mode>major</mode></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
      </attributes>
      <sound tempo="88"/>
      <harmony><root><root-step>C</root-step></root><kind value="major">major</kind></harmony>
      <note><pitch><step>E</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><staff>1</staff><type>half</type></note>
      <note><pitch><step>G</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><staff>1</staff><type>half</type></note>
      <backup><duration>8</duration></backup>
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>4</duration><voice>2</voice><staff>2</staff><type>half</type></note>
      <note><pitch><step>G</step><octave>2</octave></pitch><duration>4</duration><voice>2</voice><staff>2</staff><type>half</type></note>
    </measure>
  </part>
</score-partwise>`;

/** Страница с «диатонической» гармонией без символов — проверяет авто-достройку */
export const NO_HARMONY_MUSICXML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <work><work-title>Мелодия без аккордов</work-title></work>
  <part-list><score-part id="P1"><part-name>Melody</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>1</divisions>
        <key><fifths>0</fifths><mode>major</mode></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
      </attributes>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><type>quarter</type></note>
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><type>quarter</type></note>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><type>quarter</type></note>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><type>quarter</type></note>
    </measure>
  </part>
</score-partwise>`;

export const FIXTURES = {
  odeToJoy: ODE_TO_JOY_MUSICXML,
  twoVoice: TWO_VOICE_MUSICXML,
  noHarmony: NO_HARMONY_MUSICXML,
};