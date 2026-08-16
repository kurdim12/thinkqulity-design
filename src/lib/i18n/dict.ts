export type Locale = 'en' | 'ar';

/** Every user-facing string in the shell, in both locales. */
export const dict = {
  en: {
    appName: 'ThinkQuality Studio',
    byline: 'ALKURDI Studio · Think Quality Academy',
    nav: {
      dashboard: 'Dashboard',
      brand: 'Brand Brain',
      data: 'Data',
      concepts: 'Concepts',
      campaigns: 'Campaigns',
      calendar: 'Calendar',
      reports: 'Reports',
      board: 'The Board',
      guideline: 'Guideline',
      compliance: 'Compliance',
      settings: 'Settings',
    },
    header: {
      locale: 'Language',
      quality: 'Model',
      standard: 'Standard',
      high: 'Quality',
      signOut: 'Sign out',
      signedInAs: 'Signed in as',
      /**
       * THE ONLY PLACE THE PRODUCT DEFENDS ITSELF.
       *
       * Six screens used to carry a paragraph explaining what this app refuses
       * to do — no send button, sends nothing, never connects, never writes.
       * Said once it is a principle; said on every surface it is an apology,
       * and it crowded out the copy that told an operator what to actually do.
       * It now lives here, in a tag the width of two words, and every screen
       * that repeated it has been cut back to its own job.
       */
      readOnly: 'Read-only',
      readOnlyHint:
        'Instagram is read, never written to. Everything made here is a draft you copy out and send yourself.',
    },
    common: {
      loading: 'Loading',
      save: 'Save',
      cancel: 'Cancel',
      close: 'Close',
      edit: 'Edit',
      delete: 'Delete',
      add: 'Add',
      generate: 'Generate',
      refresh: 'Refresh',
      copy: 'Copy',
      copied: 'Copied to clipboard.',
      download: 'Download',
      account: 'Account',
      personal: 'Personal',
      academy: 'Academy',
      never: '—',
      retry: 'Retry',
      error: 'Something went wrong',
    },
    seedWarning: {
      title: 'Running on seed data',
      body: 'The agent is reasoning from facts that were written by hand, not measured. One export on the Data screen replaces them with rows it can count.',
      cta: 'Go to Data',
    },
    grounding: { data: 'grounded in data', hypothesis: 'hypothesis' },
  },
  ar: {
    appName: 'ثينك كواليتي ستوديو',
    byline: 'استوديو الكردي · أكاديمية ثينك كواليتي',
    nav: {
      dashboard: 'لوحة القيادة',
      brand: 'عقل العلامة',
      data: 'البيانات',
      concepts: 'الأفكار',
      campaigns: 'الحملات',
      calendar: 'التقويم',
      reports: 'التقارير',
      board: 'اللوحة',
      guideline: 'دليل العلامة',
      compliance: 'فاحص الالتزام',
      settings: 'الإعدادات',
    },
    header: {
      locale: 'اللغة',
      quality: 'النموذج',
      standard: 'قياسي',
      high: 'جودة عالية',
      signOut: 'تسجيل الخروج',
      signedInAs: 'مسجّل الدخول باسم',
      readOnly: 'قراءة فقط',
      readOnlyHint:
        'نقرأ إنستغرام ولا نكتب فيه. كل ما يُصنَع هنا مسودّة تنسخها وترسلها بنفسك.',
    },
    common: {
      loading: 'جارٍ التحميل',
      save: 'حفظ',
      cancel: 'إلغاء',
      close: 'إغلاق',
      edit: 'تعديل',
      delete: 'حذف',
      add: 'إضافة',
      generate: 'توليد',
      refresh: 'تحديث',
      copy: 'نسخ',
      copied: 'تم النسخ.',
      download: 'تنزيل',
      account: 'الحساب',
      personal: 'الشخصي',
      academy: 'الأكاديمية',
      never: '—',
      retry: 'إعادة المحاولة',
      error: 'حدث خطأ',
    },
    seedWarning: {
      title: 'تعمل على بيانات أولية',
      body: 'يفكّر الوكيل انطلاقاً من حقائق مكتوبة بخط اليد، لا مقيسة. تصديرٌ واحد في شاشة البيانات يستبدل بها صفوفاً يستطيع عدّها.',
      cta: 'إلى شاشة البيانات',
    },
    grounding: { data: 'مبني على البيانات', hypothesis: 'فرضية' },
  },
} as const;

export type Dict = (typeof dict)['en'];
