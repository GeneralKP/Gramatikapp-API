"""Expand manually reviewed compact Spanish rows; does not contact a database or translator."""
import json, re
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).parent
AUDIT = json.loads(Path('/tmp/gramatik-ES-audit.json').read_text())
SNAPSHOT = json.loads(Path('/tmp/gramatik-phrase-translation-snapshot.json').read_text())

verb_rows={}
for line in (ROOT/'es-verb-metadata.rows').read_text().splitlines():
    if not line or line.startswith('#'): continue
    fields=line.split('|')
    assert len(fields)==9, (line, len(fields))
    verb_rows[int(fields[0])]=fields[1:]

# Explicit reviewer-supplied irregular present forms; past/participle/imperative are in the manual rows.
es_irregular={
48:'regular present: tomo, tomas, toma',
256:'reflexive: me someto, te sometes, se somete',
301:'elijo, eliges, elige; eligió, eligieron; subjunctive elija',
317:'entiendo, entiendes, entiende',
323:'sé, sabes, sabe; subjunctive sepa; future sabré',
413:'regular present: asumo, asumes, asume',
439:'sostengo, sostienes, sostiene; sostuve; future sostendré',
454:'impongo, impones, impone; impuse; future impondré',
463:'promuevo, promueves, promueve',
533:'trasciendo, trasciendes, trasciende',
536:'me manifiesto, te manifiestas, se manifiesta',
573:'soy, eres, es, somos, sois, son; era; fui; subjunctive sea',
585:'cubro, cubres, cubre; irregular participle cubierto',
627:'hago, haces, hace; hice; future haré; irregular participle hecho',
647:'he, has, ha, hemos, habéis, han; impersonal hay; hube; future habré; rare imperative he',
820:'socavo, socavas, socava',
959:'regular present: hablo, hablas, habla',
976:'vuelvo, vuelves, vuelve; irregular participle vuelto',
992:'conozco, conoces, conoce; subjunctive conozca',
1038:'consigo, consigues, consigue; consiguió, consiguieron',
1056:'comienzo, comienzas, comienza; comencé; subjunctive comience',
1137:'pierdo, pierdes, pierde',
1259:'creo, creas, crea; creé',
1307:'me reproduzco, te reproduces, se reproduce; reproduje',
1389:'pienso, piensas, piensa',
1412:'prefiero, prefieres, prefiere; prefirió, prefirieron',
1438:'distingo, distingues, distingue; subjunctive distinga',
1456:'mantengo, mantienes, mantiene; mantuve; future mantendré',
1478:'describo, describes, describe; irregular participle descrito',
1485:'finjo, finges, finge; subjunctive finja',
1587:'obedezco, obedeces, obedece; subjunctive obedezca',
1601:'digo, dices, dice; dije; future diré; irregular participle dicho',
1673:'me enamoro, te enamoras, se enamora',
1851:'resuelvo, resuelves, resuelve; irregular participle resuelto',
}
de_irregular={
48:'du nimmst, er nimmt',83:'du gehst, er geht',124:'du lässt, er lässt',
256:'du unterziehst dich, er unterzieht sich',261:'du isst, er isst',317:'du verstehst, er versteht',
323:'ich weiß, du weißt, er weiß',335:'du hältst ein, er hält ein',413:'du übernimmst, er übernimmt',
439:'du hältst aufrecht, er hält aufrecht',454:'du legst auf, er legt auf',516:'du gibst ab, er gibt ab',
533:'du überschreitest, er überschreitet',547:'du begreifst, er begreift',573:'ich bin, du bist, er ist, wir sind',
627:'du machst, er macht',647:'ich habe, du hast, er hat',820:'du untergräbst, er untergräbt',
845:'du bringst ab, er bringt ab',959:'du sprichst, er spricht',976:'du kehrst zurück, er kehrt zurück',
992:'du lernst kennen, er lernt kennen',1056:'du beginnst, er beginnt',1098:'du erlässt, er erlässt',
1137:'du verlierst, er verliert',1259:'du erschaffst, er erschafft',1364:'du beutest aus, er beutet aus',
1389:'du denkst, er denkt',1395:'du verlässt, er verlässt',1432:'du trittst ein, er tritt ein',
1438:'du unterscheidest, er unterscheidet',1456:'du behältst bei, er behält bei',
1478:'du beschreibst, er beschreibt',1485:'du täuschst vor, er täuscht vor',
1491:'du wendest ab, er wendet ab',1583:'du verschiebst, er verschiebt',1601:'du sagst, er sagt',
1631:'du verbirgst, er verbirgt',1637:'du federst ab, er federt ab',1840:'du stellst sicher, er stellt sicher',
1854:'du überwindest, er überwindet',
}

# Canonical German headword/category overrides when the contextual gloss is descriptive.
target_override={
281:('Mama','NOUN','Meine Mama ist zu Hause.'),
292:('Kaffee','NOUN','Er trinkt den Kaffee schwarz.'),
634:('gemäß','PREPOSITION','Wir handeln gemäß dem Vertrag.'),
918:('neunzehntjahrhundertlich','ADJECTIVE','Das Ideal ist neunzehntjahrhundertlich.'),
921:('nach','PREPOSITION','Wir fahren nach Norden.'),
962:('folgend','ADJECTIVE','Der folgende Tag war ruhig.'),
1923:('bevorstehend','ADJECTIVE','Wir planen den bevorstehenden Besuch.'),
791:('viel','PRONOUN','Ich habe viel zu tun.'),
938:('zu','ADVERB','Der Kaffee ist zu heiß.'),
872:('links','ADVERB','Die Tür ist links.'),
857:('welcher','PRONOUN','Welcher Zug fährt nach Berlin?'),
1708:('hinter','PREPOSITION','Der Garten liegt hinter dem Haus.'),
320:('anders','ADVERB','Heute ist alles anders.'),
426:('je','CONJUNCTION','Je mehr wir lernen, desto besser verstehen wir es.'),
195:('sein','PRONOUN','Das ist sein Buch.'),
267:('gleich','ADJECTIVE','Die beiden Zahlen sind gleich.'),
}

# These are short German examples authored for the function-word senses.
examples={
0:'Hallo, wie geht es dir?',5:'Wo ist der Bahnhof?',10:'Ich brauche ein Ticket.',12:'Das Geschenk ist für dich.',
18:'Gestern war ich zu Hause.',22:'Ich bleibe, weil es regnet.',25:'Das ist mein Bruder.',28:'Ich wohne in Berlin.',
30:'Der Zug kommt bald.',33:'Ich gehe zu dir.',36:'Das Buch ist von ihr.',38:'Ich lerne viel.',50:'Heute habe ich weniger Zeit.',
54:'Ich glaube, dass er kommt.',58:'Ich komme heute nicht.',67:'Ruf mich vorher an.',82:'Wir essen und gehen danach ins Kino.',
84:'Während der Reise habe ich gelesen.',89:'Ich weiß, wo er wohnt.',109:'Das ist so schön.',110:'Sie singt wunderschön.',
115:'Ich rufe an, wenn ich ankomme.',126:'Ich wohne seit Januar hier.',137:'Du bist herzlich willkommen.',142:'Das ist für dich.',
160:'Sie liest, während ich koche.',170:'Ich möchte mehr erfahren.',175:'Wir müssen die Frage abschließend klären.',
200:'Ich komme, aber etwas später.',203:'Jener Tag war besonders.',208:'Wir essen und trinken.',210:'Ich habe alles vorbereitet.',
236:'Der Preis ist erheblich gestiegen.',246:'Der Zug ist schon da.',271:'Ich möchte etwas sagen.',275:'Dieser Zug fährt nach Hamburg.',
284:'Ich trinke weder Kaffee noch Tee.',290:'Möchten Sie einen Kaffee?',303:'Jemand hat angerufen.',321:'Er ist nicht müde, sondern krank.',
351:'Ich komme auch.',353:'Er singt wie ein Profi.',383:'Wir treffen uns vor dem Bahnhof.',444:'Das ist unser Haus.',
458:'Was möchtest du wissen?',488:'Der Zug ist noch nicht da.',508:'Wir prüfen das mittels eines Tests.',526:'Die Bank liegt zwischen den Häusern.',
531:'Wir sprechen über die Reise.',592:'Das gefällt mir besonders.',642:'Möchtest du Tee oder Kaffee?',646:'Der Bahnhof ist weit entfernt.',
653:'Jeder darf teilnehmen.',665:'Wir handeln gemäß den Regeln.',673:'Selbst Kinder verstehen das.',679:'Hier stand einst ein Schloss.',
704:'Vielleicht kommt sie morgen.',727:'Das ist dein Buch.',757:'So machen wir das.',766:'Einer fehlt noch.',826:'Hinter dem Haus liegt ein Garten.',
880:'Wir haben wenig Zeit.',912:'Ich möchte das wirklich verstehen.',924:'Paradoxerweise nahm die Angst zu.',935:'Ich wohne hier.',
973:'Ich freue mich wirklich.',978:'Das stimmt genau.',996:'Hoffentlich klappt es.',1021:'Sie singt unglaublich gut.',1031:'Jetzt bin ich bereit.',
1052:'Das gefällt mir gut.',1070:'Wer hat das gesagt?',1074:'Ich werde persönlich kommen.',1083:'Das war bloß ein Scherz.',
1095:'Wir haben gezielt nachgefragt.',1171:'Das ist der Mann, dessen Auto hier steht.',1215:'Die beiden Meinungen sind diametral entgegengesetzt.',
1227:'Jenes Haus gehört ihr.',1236:'Die Freude war unermesslich groß.',1239:'Welcher Zug fährt nach Köln?',1241:'Ich habe nichts gehört.',
1244:'Jener Abend bleibt unvergessen.',1246:'Ich habe kaum Zeit.',1253:'Damals wohnte ich in Berlin.',1281:'Das verändert alles unumkehrbar.',
1283:'Es ist drinnen warm.',1368:'Das hast du richtig gemacht.',1385:'Ich warte noch.',1405:'Wir essen und gehen dann nach Hause.',1414:'Sogar er hat gelacht.',
1480:'Solcher Mut beeindruckt mich.',1575:'Der Lärm wurde allmählich leiser.',1626:'Wir feiern traditionell im Familienkreis.',
1639:'Das ist praktisch unmöglich.',1668:'Die Lage hat sich radikal verändert.',1674:'Er kommt morgen.',1687:'Sie hat unbewusst gelächelt.',
1695:'Ich komme sofort.',1701:'Der Ort zieht mich magisch an.',1713:'Er hat das absichtlich getan.',1720:'Die Aufgabe ist vollständig erledigt.',
1728:'Wir haben bewusst gewartet.',1740:'Das gefällt mir sehr.',1741:'Der Bahnhof ist nah.',1781:'Der Zug fährt schnell.',
1790:'Das hat mich zutiefst bewegt.',1805:'Das stimmt absolut.',1809:'Wir halten die Regeln fest.',1843:'Wir nehmen das ernsthaft.',
1866:'Die Arbeit ist vollständig erledigt.',1868:'Heute habe ich Zeit.',1870:'Das ist völlig klar.',1877:'Ich muss dringend gehen.',
1901:'Die Tasche liegt darunter.',
}

# Abstract noun examples remain grammatical across domains and keep the target headword visible.
weak_acc={'Glaube':'Glauben','Chirurg':'Chirurgen','Sachverständiger':'Sachverständigen','Psychologe':'Psychologen',
          'Doktorand':'Doktoranden','Student':'Studenten','Staatsanwalt':'Staatsanwalt','Kumpel':'Kumpel'}
plural_only={'Leute','Kosten'}

def noun_example(word,gender):
    article={'der':'den','die':'die','das':'das'}[gender]
    noun=weak_acc.get(word,word)
    if word in plural_only:article='die'
    return f'Wir sprechen über {article} {noun}.'

CATEGORIES={'v':'VERB','j':'ADJECTIVE','d':'ADVERB','p':'PRONOUN','r':'PREPOSITION','c':'CONJUNCTION','i':'INTERJECTION','t':'ARTICLE'}
FORMS={
'np':('NOUN','plural noun'),
'af':('ADJECTIVE','feminine singular adjective'),
'ap':('ADJECTIVE','plural adjective or nominalized adjective'),
'afp':('ADJECTIVE','feminine plural adjective'),
'pf':('PRONOUN','feminine singular pronoun or determiner'),
'pfp':('PRONOUN','feminine plural pronoun or determiner'),
'ppro':('PRONOUN','plural pronoun or determiner'),
'pneut':('PRONOUN','neuter demonstrative pronoun'),
'obj':('PRONOUN','object clitic pronoun'),
'prepobj':('PRONOUN','prepositional object pronoun'),
'refl':('PRONOUN','reflexive clitic pronoun'),
'cl':('VERB','infinitive with attached clitic or passive/reflexive se'),
'ger':('VERB','gerund'),
'gercl':('VERB','gerund with attached clitic'),
'pp':('VERB','past participle, masculine singular or compound tense'),
'ppf':('VERB','feminine singular past participle'),
'ppp':('VERB','masculine plural past participle'),
'ppfp':('VERB','feminine plural past participle'),
'tf':('ARTICLE','feminine singular article'),
'tp':('ARTICLE','plural article'),
'tfp':('ARTICLE','feminine plural article'),
'comp':('ADJECTIVE','comparative form'),
'compp':('ADJECTIVE','plural comparative form'),
'super':('ADJECTIVE','intensive superlative'),
'apoc':('ADJECTIVE','apocopated adjective'),
'apocp':('PRONOUN','apocopated pronoun or determiner'),
'imp':('VERB','second-person singular affirmative imperative'),
'impcl':('VERB','second-person singular imperative with attached clitic'),
'num':('UNKNOWN','cardinal numeral'),
'numpl':('UNKNOWN','plural numeral'),
'name':('UNKNOWN','proper name or name component'),
'abbr':('UNKNOWN','initialism'),
'compound':('ADJECTIVE','relational compound adjective'),
'foreign':('NOUN','unadapted foreign loan; native Spanish dictionary equivalent supplied as lemma'),
'ct':('UNKNOWN','contraction or fused preposition-pronoun form'),
'idiom':('ADVERB','component of a fixed adverbial/prepositional expression'),
'idiomv':('VERB','infinitive used in a fixed prepositional expression'),
'dimin':('NOUN','diminutive or affectionate form'),
'amb':('UNKNOWN','context-dependent grammatical or semantic senses'),
}
PERSON={'1':'first-person singular','2':'second-person singular','3':'third-person singular',
        '1p':'first-person plural','2p':'second-person plural','3p':'third-person plural'}

def verb_form(tag):
    match=re.fullmatch(r'v(si|sp|p|t|i|c|f)(1p|2p|3p|1|2|3)',tag)
    assert match,tag
    mood,person=match.groups()
    if mood in ('si','i','c') and person in ('1','3'):
        subject='first/third-person singular'
    else:subject=PERSON[person]
    tense={'si':'imperfect subjunctive','sp':'present subjunctive','p':'present indicative','t':'preterite indicative',
           'i':'imperfect indicative','c':'conditional','f':'future indicative'}[mood]
    return 'VERB',f'{subject} {tense}'

# Display spelling is deliberately cleaned; only proper names retain context capitalization.
def display_word(m,tag):
    if tag=='name':
        return re.sub(r'^[\W_]+|[\W_]+$','',m['raw'],flags=re.UNICODE)
    if tag=='abbr':return m['word'].upper()
    return m['word']

entries=[]
seen=set()
for line in (ROOT/'es-reviewed.rows').read_text().splitlines():
    if not line or line.startswith('#'):continue
    parts=line.split('|');assert len(parts)==5,(line,len(parts))
    index=int(parts[0]);gloss,tag,lemma,cefr=parts[1:]
    assert index not in seen,index
    seen.add(index)
    m=AUDIT['missing'][index]
    word=display_word(m,tag)
    lexical=tag in CATEGORIES or tag.startswith(('nm:','nf:','nc:'))
    entry={'word':word,'key':m['word'],'translation':gloss,'kind':'LEXEME' if lexical else 'SURFACE',
           'lemma':word if lexical else lemma,'cefrLevel':cefr or 'B1.1'}
    if lexical:
        target_word=gloss.split(';')[0].strip()
        target_forms={}
        if tag.startswith(('nm:','nf:','nc:')):
            noun_tag,source_plural,target_gender,target_plural=tag.split(':')
            source_gender={'nm':'el','nf':'la','nc':'el/la'}[noun_tag]
            entry['category']='NOUN'
            entry['forms']={'gender':source_gender,'plural':source_plural if source_plural!='—' else 'no plural in this sense'}
            target_forms={'gender':target_gender,'plural':target_plural if target_plural!='—' else 'no plural in this sense'}
            target_category='NOUN'
        else:
            entry['category']=CATEGORIES[tag]
            target_category=entry['category']
            entry['forms']={}
        if tag=='v':
            past,perfect,imperative,target_word,de_past,de_perfect,de_imperative,example=verb_rows[index]
            entry['forms']={'past':past,'perfect':perfect,'imperativ':imperative,
                            'irregularConjugations':es_irregular.get(index,'regular conjugation')}
            target_forms={'past':de_past,'perfect':de_perfect,'imperativ':de_imperative,
                          'irregularConjugations':de_irregular.get(index,'regular conjugation')}
        else:
            example=examples.get(index)
        if index in target_override:
            target_word,target_category,example=target_override[index]
        if not example:
            if target_category=='NOUN':example=noun_example(target_word,target_forms['gender'])
            elif target_category=='ADJECTIVE':example=f'Das wirkt {target_word}.'
            else:raise AssertionError(('missing example',index,word,target_category))
        entry['form']='dictionary form'
        entry['target']={'word':target_word,'category':target_category,'forms':target_forms,
                         'cefrLevel':entry['cefrLevel'],'example':example}
    else:
        assert lemma,('missing lemma',index,word)
        entry['category'],entry['form']=FORMS[tag] if tag in FORMS else verb_form(tag)
    entries.append(entry)

assert seen==set(range(len(AUDIT['missing'])))
assert len({e['key'] for e in entries})==len(entries)
for entry in entries:
    assert entry['translation'] and entry['lemma']
    assert re.fullmatch(r'[ABC][12]\.[12]',entry['cefrLevel'])
    if entry['kind']=='LEXEME':
        assert entry['category']!='UNKNOWN'
        assert entry['target']['example']
        for side in (entry,entry['target']):
            if side['category']=='NOUN':
                assert side['forms']['plural'] and side['forms']['gender']
                if side is entry['target']:assert side['forms']['gender'] in ('der','die','das')
            if side['category']=='VERB':
                assert all(side['forms'].get(f) for f in ('past','perfect','imperativ'))

output={'language':'ES','reviewDate':'2026-10-06','reviewMethod':'Manual phrase-by-phrase review of all 276 primary Spanish phrases; normalized-token deduplication; no translation services or AI API calls.',
        'sourceAudit':'gramatik-ES-audit.json','coverage':{'phrasesReviewed':len(AUDIT['phrases']),'missingTokensReviewed':len(entries),**Counter(e['kind'] for e in entries)},
        'notes':[
            'Existing records and phrase references are preserved by the importer. Surface rows never authorize inflected catalog records.',
            'CEFR sublevels are manual estimates of the token/sense, not externally certified classifications.',
            'Noun examples use a short grammatical German frame. Verb and function-word examples are individually supplied.',
            'Names, numerals, clitic pronouns, contractions, morphological forms and mixed-category keys use directional SURFACE translations.',
            'German headwords may use a shorter canonical equivalent while translation retains a descriptive contextual gloss.',
        ],'entries':entries}
(ROOT/'es-reviewed.json').write_text(json.dumps(output,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(output['coverage']))
print('Dictionary categories:',dict(Counter(e['category'] for e in entries if e['kind']=='LEXEME')))
