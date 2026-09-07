/**
 * What to tell a shop owner who does not know what a refresh token is.
 *
 * This is the half of the connector that is not code. Most owners of a shop in
 * Bakaara or a warehouse in Berbera did not set up their own QuickBooks or
 * Odoo — an accountant did, or the company that sold them the system. So the
 * useful thing the product can do is not a better form. It is to say, in their
 * language, exactly what to ask for and who to ask.
 *
 * Hence `request`: a message the owner copies and sends on. It names the four
 * things we need in the words the person who set the system up will recognise,
 * and it says what we do and do not do with them — because the first question
 * that comes back is always "why do they want my password".
 *
 * The steps are for the owner who *can* get at it themselves. They are short on
 * purpose: a fifteen-step walkthrough of Intuit's developer portal would be out
 * of date within a release, so these say where to go and stop.
 */

export type StoreSource = 'excel' | 'quickbooks' | 'odoo';
export type SetupLanguage = 'en' | 'so';

type Guide = {
  /** One line: what connecting this source actually means. */
  summary: string;
  /** Where to get the credentials, for an owner who has the access. */
  steps: string[];
  /** Who to ask when they do not. */
  askWho: string;
  /** A message to copy and send to that person. */
  request: string;
};

const GUIDES: Record<StoreSource, Record<SetupLanguage, Guide>> = {
  excel: {
    en: {
      summary:
        'Nothing to connect. Upload your sales sheet and the agent reads it — columns can be named in English or Somali.',
      steps: [
        'Upload the shop’s sheet on the workspace’s Data tab.',
        'Come back here and choose “Read my store now”.',
        'The agent finds the date, amount and type columns itself and tells you what it found.',
      ],
      askWho: 'Whoever keeps the sheet — usually you.',
      request:
        'Please send me the shop’s sales spreadsheet for the months we want reported, as an Excel or CSV file.',
    },
    so: {
      summary:
        'Wax la isku xiro ma jiro. Soo shub warqadda iibka, wakiilkuna wuu akhrinayaa — magacyada tiirarka af Ingiriisi ama af Soomaali way noqon karaan.',
      steps: [
        'Warqadda dukaanka ka soo shub tabka Data ee workspace-ka.',
        'Halkan ku noqo oo dooro “Akhri dukaankayga hadda”.',
        'Wakiilku wuxuu iskiis u helayaa tiirarka taariikhda, qiimaha iyo nooca, wuxuuna kuu sheegayaa waxa uu helay.',
      ],
      askWho: 'Qofka warqadda haya — badanaa adiga.',
      request:
        'Fadlan ii soo dir warqadda iibka ee dukaanka bilaha aan warbixinta u baahannahay, oo ah Excel ama CSV.',
    },
  },

  quickbooks: {
    en: {
      summary:
        'The agent reads your invoices, sales receipts, credit notes and purchases directly from your QuickBooks Online company.',
      steps: [
        'The four values come from an Intuit developer app connected to your company: a Client ID, a Client secret, a Refresh token and your Company (realm) ID.',
        'If your accountant or bookkeeper set up QuickBooks for you, they can produce these — you do not need to create anything yourself.',
        'Paste whatever they send, in whatever form. A JSON file, an email, four lines — the agent works out which is which.',
      ],
      askWho: 'Your accountant, bookkeeper, or whoever set up your QuickBooks.',
      request:
        'I am connecting our QuickBooks Online company to a reporting tool so it can read our sales and expenses. Could you send me these four values?\n\n' +
        '  • Client ID\n' +
        '  • Client secret\n' +
        '  • Refresh token\n' +
        '  • Company (realm) ID\n\n' +
        'The tool only reads — it will not post, edit or delete anything in QuickBooks. The values are stored encrypted and are never shown again once saved.',
    },
    so: {
      summary:
        'Wakiilku si toos ah wuxuu uga akhrinayaa QuickBooks Online-kaaga rasiidyada iibka, faturaha, celinta iyo iibsiga.',
      steps: [
        'Afarta qiimo waxay ka yimaadaan barnaamij Intuit ah oo lala xiray shirkaddaada: Client ID, Client secret, Refresh token iyo Company (realm) ID.',
        'Haddii xisaabiyahaagu QuickBooks kuu sameeyay, isagaa ku heli kara — adigu waxba samayn maysid.',
        'Wax kasta oo ay kuu soo diraan halkan ku dhaji, si kastoo ay u qoran yihiin. Fayl JSON ah, email, ama afar sadar — wakiilku wuu kala saarayaa.',
      ],
      askWho: 'Xisaabiyahaaga, ama qofkii QuickBooks kuu sameeyay.',
      request:
        'Waxaan QuickBooks Online-keena ku xirayaa qalab warbixineed si uu u akhriyo iibkeena iyo kharashkeena. Ma ii soo diri kartaa afartan qiimo?\n\n' +
        '  • Client ID\n' +
        '  • Client secret\n' +
        '  • Refresh token\n' +
        '  • Company (realm) ID\n\n' +
        'Qalabku wax uun buu akhriyaa — waxba kuma qorayo, ma bedelayo, mana tirtirayo QuickBooks gudihiisa. Qiimayaasha si sir ah ayaa loo kaydiyaa, mar dambena lama tusayo.',
    },
  },

  odoo: {
    en: {
      summary:
        'The agent reads the posted general ledger from your Odoo, so the figures agree with your own Odoo profit and loss.',
      steps: [
        'It needs four things: your Odoo address, the database name, a username, and an API key for that user.',
        'An API key is made inside Odoo under Preferences → Account Security → New API Key. It is not the user’s password.',
        'The user only needs read access to Accounting. A read-only user is the right choice.',
        'Paste whatever you have — the address alone, or the whole file. The agent says what is still missing.',
      ],
      askWho: 'The company that installed your Odoo, or whoever administers it.',
      request:
        'I am connecting our Odoo to a reporting tool so it can read our sales and expenses. Could you send me these four things?\n\n' +
        '  • The Odoo address (the https:// link we use in a browser)\n' +
        '  • The database name\n' +
        '  • A username for the tool to use\n' +
        '  • An API key for that user (Preferences → Account Security → New API Key)\n\n' +
        'Read access to Accounting is enough — please do not give it more than that. The tool only reads; it will not post or change anything in Odoo. The key is stored encrypted and is never shown again once saved.',
    },
    so: {
      summary:
        'Wakiilku wuxuu ka akhrinayaa Odoo-gaaga xisaabaadka la duubay, sidaas darteed tirooyinku waxay la mid noqonayaan kuwa Odoo-gaagu tuso.',
      steps: [
        'Wuxuu u baahan yahay afar shay: cinwaanka Odoo, magaca database-ka, magac isticmaale, iyo API key isticmaalahaas.',
        'API key waxaa laga sameeyaa Odoo gudihiisa: Preferences → Account Security → New API Key. Ma aha password-ka isticmaalaha.',
        'Isticmaaluhu wuxuu u baahan yahay oo keliya akhrinta Accounting. Isticmaale wax-akhriya oo keliya ayaa ku habboon.',
        'Wax kasta oo aad haysato ku dhaji — cinwaanka oo keliya, ama faylka oo dhan. Wakiilku wuxuu kuu sheegayaa waxa wali maqan.',
      ],
      askWho: 'Shirkaddii Odoo kuu rakibtay, ama qofka maamula.',
      request:
        'Waxaan Odoo-geena ku xirayaa qalab warbixineed si uu u akhriyo iibkeena iyo kharashkeena. Ma ii soo diri kartaa afartan shay?\n\n' +
        '  • Cinwaanka Odoo (linkiga https:// ee aan browser-ka ku isticmaalno)\n' +
        '  • Magaca database-ka\n' +
        '  • Magac isticmaale oo qalabku isticmaalo\n' +
        '  • API key isticmaalahaas (Preferences → Account Security → New API Key)\n\n' +
        'Akhrinta Accounting way ku filan tahay — fadlan ha siin wax ka badan. Qalabku wax uun buu akhriyaa; waxba kuma qorayo Odoo mana bedelayo. Furaha si sir ah ayaa loo kaydiyaa, mar dambena lama tusayo.',
    },
  },
};

export function setupGuide(source: StoreSource, language: SetupLanguage = 'en'): Guide {
  return GUIDES[source][language] ?? GUIDES[source].en;
}

/**
 * Whether this source needs anything pasted at all.
 *
 * A spreadsheet store reads files the shop has already uploaded, so it has no
 * credential — which is exactly why it is the one to start with, and why the
 * form should not show a paste box that means nothing.
 */
export function needsCredentials(source: StoreSource): boolean {
  return source !== 'excel';
}
