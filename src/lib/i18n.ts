// Words for the simple stock screens, in English and Hindi.
// To add a language (e.g. Telugu), copy the `hi` block, translate it,
// and add it to LANGS. Missing words fall back to English.
import { useCallback, useState } from 'react';

const en = {
  stock: 'Stock',
  in: 'Stock IN', in_hint: 'Things that came in',
  out: 'Stock OUT', out_hint: 'Damaged, expired, samples',
  count: 'COUNT', count_hint: 'Count what is on the shelf',
  find: 'FIND', find_hint: 'How many do we have?',
  stickers: 'STICKERS', stickers_hint: 'Print barcode stickers',
  counts_to_check: 'Stock counts to check', detailed: 'Detailed stock list (managers)',
  scan_title: 'Scan the barcode', scan_hint: 'Point the camera at the sticker, or use the scanner gun.',
  no_barcode: 'No sticker? Choose from the list', search: 'Type a name…', unknown: 'We don\'t know this barcode: {code}',
  finished: 'Our products', raw_material: 'Ingredients', packaging: 'Packaging',
  packs: 'packs', pcs: 'pieces', kg: 'kg', g: 'g', l: 'litres', ml: 'ml',
  where_from: 'Where did it come from?', from_kitchen: 'Made in our kitchen',
  from_kitchen_recipe: 'The ingredients will be taken off stock automatically.',
  from_kitchen_plan: 'Production run {code}', delivery_from: 'Delivery from {supplier}',
  still_to_come: '{n} still to come · order {po}',
  no_po: 'There is no purchase order for this item. Ask your manager to make one first.',
  cant_make: 'Ask your manager to set the shelf life or recipe for this product first.',
  how_many_in: 'How many came in?', confirm_in: 'Add {n} {unit} of {name}?', yes_add: 'Yes, add',
  why_out: 'Why is it going out?', damaged: 'Damaged / broken', expired: 'Expired', sample: 'Free sample / tasting',
  how_many_out: 'How many?', confirm_out: 'Take {n} {unit} of {name} off the shelf?', yes_remove: 'Yes, take off',
  count_instr: 'Count every one of these on the shelf.', count_dont: 'Don\'t count packed orders or damaged packs.',
  how_many_count: 'How many did you count?', confirm_count: 'You counted {n} {unit}. Send?', yes_send: 'Yes, send',
  count_ok: 'Correct! The count matches.', count_pending: 'Sent to your manager to check.',
  count_diff: 'The system had {sys}. You counted {n}.', count_applied: 'Stock changed to your count.',
  added: '{n} {unit} added', removed: '{n} {unit} taken off', now_on_shelf: 'Now on the shelf: {n}',
  next: 'Next item', print_n: 'Print {n} stickers', back_home: 'Back to Stock', go_back: 'Go back', change: 'Change',
  batch: 'Batch', best_before: 'Best before', use_first: 'Use first', expired_tag: 'Expired — take off the shelf',
  on_hold: 'On hold', free_to_sell: 'free to sell', on_shelf: 'on the shelf', promised: 'kept for orders',
  no_stock: 'None on the shelf', this_batch: 'Only batch {code}', days_left: '{n} days left',
  remove_expired: 'Take expired off', max: 'At most {n}',
  product_sticker: 'Product sticker', product_sticker_hint: 'Barcode and price, for every pack',
  batch_sticker: 'Batch sticker', batch_sticker_hint: 'Barcode with best-before date',
  which_batch: 'Which batch?', how_many_stickers: 'How many stickers?', sticker_size: 'Sticker paper',
  a4_24: 'A4 sheet · 24 stickers', a4_40: 'A4 sheet · 40 small stickers', roll: 'Sticker printer · 50 × 25 mm',
  stickers_unit: 'stickers', print: 'Print', barcode_book: 'Barcode book',
  barcode_book_hint: 'One page with every item. Scan from it when a pack has no sticker.',
  clear: 'Clear', error: 'That didn\'t work', try_again: 'Try again', loading: 'Loading…',
};
type Key = keyof typeof en;

const hi: Partial<Record<Key, string>> = {
  stock: 'स्टॉक',
  in: 'माल आया', in_hint: 'जो सामान आया है',
  out: 'माल निकाला', out_hint: 'टूटा, एक्सपायर, सैंपल',
  count: 'गिनती', count_hint: 'शेल्फ पर कितना है गिनें',
  find: 'खोजें', find_hint: 'हमारे पास कितना है?',
  stickers: 'स्टिकर', stickers_hint: 'बारकोड स्टिकर छापें',
  counts_to_check: 'जाँच के लिए गिनतियाँ', detailed: 'पूरी स्टॉक सूची (मैनेजर)',
  scan_title: 'बारकोड स्कैन करें', scan_hint: 'कैमरा स्टिकर पर रखें, या स्कैनर गन से स्कैन करें।',
  no_barcode: 'स्टिकर नहीं है? सूची से चुनें', search: 'नाम लिखें…', unknown: 'यह बारकोड हमारे पास नहीं है: {code}',
  finished: 'हमारे उत्पाद', raw_material: 'कच्चा माल', packaging: 'पैकिंग सामान',
  packs: 'पैकेट', pcs: 'नग', kg: 'किलो', g: 'ग्राम', l: 'लीटर', ml: 'मि.ली.',
  where_from: 'कहाँ से आया?', from_kitchen: 'हमारी रसोई में बना',
  from_kitchen_recipe: 'कच्चा माल स्टॉक से अपने आप कम हो जाएगा।',
  from_kitchen_plan: 'प्रोडक्शन {code}', delivery_from: '{supplier} से डिलीवरी',
  still_to_come: '{n} आना बाकी · ऑर्डर {po}',
  no_po: 'इस सामान का कोई खरीद ऑर्डर नहीं है। पहले मैनेजर से ऑर्डर बनवाएँ।',
  cant_make: 'पहले मैनेजर से इस उत्पाद की शेल्फ लाइफ या रेसिपी डलवाएँ।',
  how_many_in: 'कितने आए?', confirm_in: '{name} के {n} {unit} जोड़ें?', yes_add: 'हाँ, जोड़ें',
  why_out: 'क्यों निकाल रहे हैं?', damaged: 'टूटा / खराब', expired: 'एक्सपायर', sample: 'मुफ़्त सैंपल / चखने के लिए',
  how_many_out: 'कितने?', confirm_out: '{name} के {n} {unit} शेल्फ से निकालें?', yes_remove: 'हाँ, निकालें',
  count_instr: 'शेल्फ पर रखे सभी गिनें।', count_dont: 'पैक हुए ऑर्डर और टूटे पैकेट न गिनें।',
  how_many_count: 'आपने कितने गिने?', confirm_count: 'आपने {n} {unit} गिने। भेजें?', yes_send: 'हाँ, भेजें',
  count_ok: 'सही! गिनती मिल गई।', count_pending: 'जाँच के लिए मैनेजर को भेज दिया।',
  count_diff: 'सिस्टम में {sys} थे। आपने {n} गिने।', count_applied: 'स्टॉक आपकी गिनती के अनुसार बदल गया।',
  added: '{n} {unit} जुड़ गए', removed: '{n} {unit} निकाल दिए', now_on_shelf: 'अब शेल्फ पर: {n}',
  next: 'अगला सामान', print_n: '{n} स्टिकर छापें', back_home: 'स्टॉक पर वापस', go_back: 'वापस', change: 'बदलें',
  batch: 'बैच', best_before: 'इससे पहले इस्तेमाल करें', use_first: 'पहले यह दें', expired_tag: 'एक्सपायर — शेल्फ से हटाएँ',
  on_hold: 'रोका गया', free_to_sell: 'बेचने के लिए', on_shelf: 'शेल्फ पर', promised: 'ऑर्डर के लिए रखे',
  no_stock: 'शेल्फ पर कुछ नहीं', this_batch: 'सिर्फ़ बैच {code}', days_left: '{n} दिन बाकी',
  remove_expired: 'एक्सपायर हटाएँ', max: 'ज़्यादा से ज़्यादा {n}',
  product_sticker: 'उत्पाद स्टिकर', product_sticker_hint: 'बारकोड और दाम, हर पैकेट के लिए',
  batch_sticker: 'बैच स्टिकर', batch_sticker_hint: 'बारकोड और एक्सपायरी तारीख',
  which_batch: 'कौन सा बैच?', how_many_stickers: 'कितने स्टिकर?', sticker_size: 'स्टिकर पेपर',
  a4_24: 'A4 शीट · 24 स्टिकर', a4_40: 'A4 शीट · 40 छोटे स्टिकर', roll: 'स्टिकर प्रिंटर · 50 × 25 मि.मी.',
  stickers_unit: 'स्टिकर', print: 'छापें', barcode_book: 'बारकोड किताब',
  barcode_book_hint: 'एक पेज पर सारे सामान। जब पैकेट पर स्टिकर न हो, तो यहाँ से स्कैन करें।',
  clear: 'मिटाएँ', error: 'यह नहीं हुआ', try_again: 'फिर कोशिश करें', loading: 'लोड हो रहा है…',
};

export const LANGS = { en: { name: 'English', words: en }, hi: { name: 'हिंदी', words: hi } } as const;
export type Lang = keyof typeof LANGS;

function savedLang(): Lang {
  try {
    const v = localStorage.getItem('tl-lang');
    return v && v in LANGS ? (v as Lang) : 'en';
  } catch { return 'en'; }
}

export function useT() {
  const [lang, setLangState] = useState<Lang>(savedLang);
  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try { localStorage.setItem('tl-lang', l); } catch { /* private mode */ }
  }, []);
  const t = useCallback((key: Key, vars: Record<string, string | number> = {}) => {
    const s = (LANGS[lang].words as Partial<Record<Key, string>>)[key] ?? en[key] ?? key;
    return s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
  }, [lang]);
  return { t, lang, setLang };
}
export type T = ReturnType<typeof useT>['t'];
