// Words for the simple stock screens, in English and Hindi.
// To add a language (e.g. Telugu), copy the `hi` block, translate it,
// and add it to LANGS. Missing words fall back to English.
import { useCallback, useEffect, useState } from 'react';

const en = {
  stock: 'Inventory',
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
  // Orders & Process
  orders: 'Orders', tab_process: 'Process', tab_inventory: 'Inventory', tab_more: 'More', dashboard_link: 'Business dashboard →', scan_order: 'Scan or type an order number', no_order: 'No order {code}',
  to_do: 'To do', sent: 'Sent', nothing_to_do: 'No orders waiting. 🎉', nothing_sent: 'Nothing sent yet.',
  k_ready: 'Ready', k_make: 'Make first', k_repack: 'Repack first', k_rm_short: 'Raw material out', k_no_recipe: 'No recipe',
  k_packed: 'Packed', k_sent: 'Sent', k_unpaid: 'Waiting for payment', k_failed: 'Delivery failed',
  process: 'Process', see_short: 'See what is short', dispatch: 'Dispatch', invoice: 'Invoice', open_order: 'Open order',
  steps: 'Steps', step_make: 'Make', step_pack: 'Pack', step_dispatch: 'Dispatch', step_done: 'Invoice',
  collect_cod: 'Cash on delivery — the courier collects {amount}', back_orders: 'Back to orders',
  make_title: 'Make {name}', repack_title: 'Repack {name}',
  no_recipe_msg: 'There is no recipe for this product, so the system doesn\'t know what to use. Ask your manager to add one.',
  add_recipe: 'Add a recipe', not_in_recipe: '{name} is not used for this product', batch_expired: 'Batch {code} has expired — don\'t use it',
  made_n: '{n} packs made', repacked_n: '{n} packs repacked', continue: 'Continue',
  how_many_made: 'How many packs did you make?', how_many_repacked: 'How many packs did you fill?',
  materials_auto: 'The raw material used is taken off stock automatically (oldest first).', yes_made: 'Yes, {n} packs done',
  order_needs: 'This order needs {n} more · one batch makes {per}', more_products: '{n} more product(s) after this',
  how_many_to_make: 'How many will you make?', how_many_to_repack: 'How many packs will you fill?',
  less_than_order: 'That is less than the order needs ({n}).',
  rm_out_title: 'Raw material is short', material: 'Material', need: 'Need', have: 'Have', short: 'Short',
  order_rm: 'Order raw material', show_manager: 'Show this screen to your manager so they can order it.',
  scan_bulk: 'Scan the bulk pack you are repacking from', scan_each_rm: 'Scan each raw material as you take it',
  ticked: 'Ticked by hand', tick_by_hand: 'No sticker — tick',
  mis_title: 'Cost and margin (estimate)', cost_batch: 'Cost of this batch', cost_pack: 'Cost per pack', sells_at: 'Sells at (website)', margin: 'Margin',
  missing_costs: 'Some raw materials have no cost yet, so the real cost is higher.',
  cant_make_short: 'Can\'t start — raw material short', make_now: 'Made it', repack_now: 'Repacked it', tick_all_first: 'Scan or tick every item first',
  ask_warehouse: 'Ask the warehouse team to make this.', delivered: 'Delivered',
  open_invoice: 'Open invoice {code}', invoice_pending: 'Invoice not issued yet — the company GST details are missing (manager: Accounts → Setup).',
  track: 'Track delivery',
  step_repack: 'Repack', for_orders: 'Needed for orders', for_stock: 'Make or repack for stock',
  nothing_to_make: 'Nothing to make — every order has stock.', no_recipes_yet: 'No recipes yet. A manager adds them under More → Production.',
  short_for_orders: '{n} short · for {orders}', orders_need: 'Waiting orders need {n} · one batch makes {per}', per_batch: 'One batch makes {per}',
  // Packing
  fifo_warn: 'Take the older batch first: {code} (best before {date})', ok_take_older: 'OK, I\'ll take the older one', use_anyway: 'Use this one anyway',
  wait_stock: 'This order is waiting for stock — do not pack.', not_paid: 'Not paid yet — do not pack or send.',
  scanned_of: '{n} of {total} items scanned', take_from: 'Take from {code} · best before {date}',
  scan_batch_label: 'Now scan the batch label for {name}', no_label_pick: 'No label? Pick the batch printed on the pack:',
  scan_batch_short: 'Scan batch label', scan_pack: 'Scan each pack', mark_packed: 'Mark as packed', scan_more: 'Scan {n} more',
  packed_at: 'Packed {when}',
  delivery_by: 'Delivery by', booking_ref: 'Booking reference', booking_ref_opt: 'Reference (optional)',
  tracking_link: 'Tracking link (optional)', delivery_cost: 'Delivery cost ₹ (optional)', confirm_dispatch: 'Confirm dispatch',
};
type Key = keyof typeof en;

const hi: Partial<Record<Key, string>> = {
  stock: 'इन्वेंटरी',
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
  orders: 'ऑर्डर', tab_process: 'प्रोसेस', tab_inventory: 'इन्वेंटरी', tab_more: 'और', dashboard_link: 'बिज़नेस डैशबोर्ड →', scan_order: 'ऑर्डर नंबर स्कैन करें या लिखें', no_order: 'ऑर्डर {code} नहीं मिला',
  to_do: 'करना है', sent: 'भेज दिए', nothing_to_do: 'कोई ऑर्डर बाकी नहीं। 🎉', nothing_sent: 'अभी कुछ नहीं भेजा।',
  k_ready: 'तैयार', k_make: 'पहले बनाना है', k_repack: 'पहले रीपैक करना है', k_rm_short: 'कच्चा माल खत्म', k_no_recipe: 'रेसिपी नहीं',
  k_packed: 'पैक हो गया', k_sent: 'भेज दिया', k_unpaid: 'पेमेंट बाकी', k_failed: 'डिलीवरी नहीं हुई',
  process: 'शुरू करें', see_short: 'क्या कम है देखें', dispatch: 'भेजें', invoice: 'बिल', open_order: 'ऑर्डर खोलें',
  steps: 'स्टेप', step_make: 'बनाएँ', step_pack: 'पैक', step_dispatch: 'भेजें', step_done: 'बिल',
  collect_cod: 'कैश ऑन डिलीवरी — कूरियर {amount} लेगा', back_orders: 'ऑर्डर पर वापस',
  make_title: '{name} बनाएँ', repack_title: '{name} रीपैक करें',
  no_recipe_msg: 'इस उत्पाद की रेसिपी नहीं है, इसलिए सिस्टम को नहीं पता क्या इस्तेमाल करना है। मैनेजर से रेसिपी डलवाएँ।',
  add_recipe: 'रेसिपी डालें', not_in_recipe: '{name} इस उत्पाद में इस्तेमाल नहीं होता', batch_expired: 'बैच {code} एक्सपायर है — इस्तेमाल न करें',
  made_n: '{n} पैकेट बन गए', repacked_n: '{n} पैकेट रीपैक हो गए', continue: 'आगे बढ़ें',
  how_many_made: 'कितने पैकेट बने?', how_many_repacked: 'कितने पैकेट भरे?',
  materials_auto: 'इस्तेमाल हुआ कच्चा माल स्टॉक से अपने आप कम होगा (पुराना पहले)।', yes_made: 'हाँ, {n} पैकेट तैयार',
  order_needs: 'इस ऑर्डर को {n} और चाहिए · एक बैच में {per} बनते हैं', more_products: 'इसके बाद {n} और उत्पाद',
  how_many_to_make: 'कितने बनाएँगे?', how_many_to_repack: 'कितने पैकेट भरेंगे?',
  less_than_order: 'यह ऑर्डर की ज़रूरत ({n}) से कम है।',
  rm_out_title: 'कच्चा माल कम है', material: 'सामान', need: 'चाहिए', have: 'है', short: 'कम',
  order_rm: 'कच्चा माल मँगवाएँ', show_manager: 'यह स्क्रीन मैनेजर को दिखाएँ ताकि वे मँगवा सकें।',
  scan_bulk: 'जिस बड़े पैक से भर रहे हैं उसे स्कैन करें', scan_each_rm: 'हर कच्चा माल लेते समय स्कैन करें',
  ticked: 'हाथ से टिक किया', tick_by_hand: 'स्टिकर नहीं — टिक करें',
  mis_title: 'लागत और मार्जिन (अनुमान)', cost_batch: 'इस बैच की लागत', cost_pack: 'एक पैकेट की लागत', sells_at: 'बिक्री दाम (वेबसाइट)', margin: 'मार्जिन',
  missing_costs: 'कुछ कच्चे माल की लागत नहीं डली है, असली लागत ज़्यादा है।',
  cant_make_short: 'शुरू नहीं कर सकते — कच्चा माल कम है', make_now: 'बन गया', repack_now: 'रीपैक हो गया', tick_all_first: 'पहले हर सामान स्कैन या टिक करें',
  ask_warehouse: 'वेयरहाउस टीम से बनवाएँ।', delivered: 'डिलीवर हो गया',
  open_invoice: 'बिल {code} खोलें', invoice_pending: 'बिल अभी नहीं बना — कंपनी की GST जानकारी नहीं डली (मैनेजर: Accounts → Setup)।',
  track: 'डिलीवरी ट्रैक करें',
  step_repack: 'रीपैक', for_orders: 'ऑर्डर के लिए चाहिए', for_stock: 'स्टॉक के लिए बनाएँ या रीपैक करें',
  nothing_to_make: 'कुछ नहीं बनाना — हर ऑर्डर का स्टॉक है।', no_recipes_yet: 'अभी कोई रेसिपी नहीं। मैनेजर More → Production में डालते हैं।',
  short_for_orders: '{n} कम · {orders} के लिए', orders_need: 'बाकी ऑर्डर को {n} चाहिए · एक बैच में {per} बनते हैं', per_batch: 'एक बैच में {per} बनते हैं',
  fifo_warn: 'पहले पुराना बैच लें: {code} ({date} से पहले इस्तेमाल करें)', ok_take_older: 'ठीक है, पुराना लूँगा', use_anyway: 'फिर भी यही लें',
  wait_stock: 'यह ऑर्डर स्टॉक का इंतज़ार कर रहा है — पैक न करें।', not_paid: 'पेमेंट नहीं हुआ — न पैक करें, न भेजें।',
  scanned_of: '{total} में से {n} स्कैन हुए', take_from: '{code} से लें · {date} से पहले',
  scan_batch_label: 'अब {name} का बैच लेबल स्कैन करें', no_label_pick: 'लेबल नहीं? पैकेट पर छपा बैच चुनें:',
  scan_batch_short: 'बैच लेबल स्कैन करें', scan_pack: 'हर पैकेट स्कैन करें', mark_packed: 'पैक हो गया', scan_more: '{n} और स्कैन करें',
  packed_at: 'पैक हुआ {when}',
  delivery_by: 'डिलीवरी किससे', booking_ref: 'बुकिंग नंबर', booking_ref_opt: 'नंबर (ज़रूरी नहीं)',
  tracking_link: 'ट्रैकिंग लिंक (ज़रूरी नहीं)', delivery_cost: 'डिलीवरी खर्च ₹ (ज़रूरी नहीं)', confirm_dispatch: 'भेजना पक्का करें',
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
  // every screen and the tab bar switch together
  useEffect(() => {
    const on = (e: Event) => setLangState((e as CustomEvent<Lang>).detail);
    window.addEventListener('tl-lang', on);
    return () => window.removeEventListener('tl-lang', on);
  }, []);
  const setLang = useCallback((l: Lang) => {
    try { localStorage.setItem('tl-lang', l); } catch { /* private mode */ }
    window.dispatchEvent(new CustomEvent('tl-lang', { detail: l }));
  }, []);
  const t = useCallback((key: Key, vars: Record<string, string | number> = {}) => {
    const s = (LANGS[lang].words as Partial<Record<Key, string>>)[key] ?? en[key] ?? key;
    return s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
  }, [lang]);
  return { t, lang, setLang };
}
export type T = ReturnType<typeof useT>['t'];
