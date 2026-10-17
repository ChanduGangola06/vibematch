export interface Country {
  code: string;
  name: string;
  flag: string;
}

export function getFlagEmoji(countryCode: string): string {
  if (!countryCode) return '';
  const codePoints = countryCode
    .toUpperCase()
    .split('')
    .map((char) => 127397 + char.charCodeAt(0));
  return String.fromCodePoint(...codePoints);
}

export const COUNTRIES: Country[] = [
  { code: 'AF', name: 'Afghanistan', flag: getFlagEmoji('AF') },
  { code: 'AL', name: 'Albania', flag: getFlagEmoji('AL') },
  { code: 'DZ', name: 'Algeria', flag: getFlagEmoji('DZ') },
  { code: 'AD', name: 'Andorra', flag: getFlagEmoji('AD') },
  { code: 'AO', name: 'Angola', flag: getFlagEmoji('AO') },
  { code: 'AR', name: 'Argentina', flag: getFlagEmoji('AR') },
  { code: 'AM', name: 'Armenia', flag: getFlagEmoji('AM') },
  { code: 'AU', name: 'Australia', flag: getFlagEmoji('AU') },
  { code: 'AT', name: 'Austria', flag: getFlagEmoji('AT') },
  { code: 'AZ', name: 'Azerbaijan', flag: getFlagEmoji('AZ') },
  { code: 'BH', name: 'Bahrain', flag: getFlagEmoji('BH') },
  { code: 'BD', name: 'Bangladesh', flag: getFlagEmoji('BD') },
  { code: 'BY', name: 'Belarus', flag: getFlagEmoji('BY') },
  { code: 'BE', name: 'Belgium', flag: getFlagEmoji('BE') },
  { code: 'BO', name: 'Bolivia', flag: getFlagEmoji('BO') },
  { code: 'BA', name: 'Bosnia and Herzegovina', flag: getFlagEmoji('BA') },
  { code: 'BR', name: 'Brazil', flag: getFlagEmoji('BR') },
  { code: 'BG', name: 'Bulgaria', flag: getFlagEmoji('BG') },
  { code: 'CM', name: 'Cameroon', flag: getFlagEmoji('CM') },
  { code: 'CA', name: 'Canada', flag: getFlagEmoji('CA') },
  { code: 'CL', name: 'Chile', flag: getFlagEmoji('CL') },
  { code: 'CN', name: 'China', flag: getFlagEmoji('CN') },
  { code: 'CO', name: 'Colombia', flag: getFlagEmoji('CO') },
  { code: 'CR', name: 'Costa Rica', flag: getFlagEmoji('CR') },
  { code: 'HR', name: 'Croatia', flag: getFlagEmoji('HR') },
  { code: 'CU', name: 'Cuba', flag: getFlagEmoji('CU') },
  { code: 'CY', name: 'Cyprus', flag: getFlagEmoji('CY') },
  { code: 'CZ', name: 'Czechia', flag: getFlagEmoji('CZ') },
  { code: 'DK', name: 'Denmark', flag: getFlagEmoji('DK') },
  { code: 'DO', name: 'Dominican Republic', flag: getFlagEmoji('DO') },
  { code: 'EC', name: 'Ecuador', flag: getFlagEmoji('EC') },
  { code: 'EG', name: 'Egypt', flag: getFlagEmoji('EG') },
  { code: 'SV', name: 'El Salvador', flag: getFlagEmoji('SV') },
  { code: 'EE', name: 'Estonia', flag: getFlagEmoji('EE') },
  { code: 'FI', name: 'Finland', flag: getFlagEmoji('FI') },
  { code: 'FR', name: 'France', flag: getFlagEmoji('FR') },
  { code: 'GE', name: 'Georgia', flag: getFlagEmoji('GE') },
  { code: 'DE', name: 'Germany', flag: getFlagEmoji('DE') },
  { code: 'GH', name: 'Ghana', flag: getFlagEmoji('GH') },
  { code: 'GR', name: 'Greece', flag: getFlagEmoji('GR') },
  { code: 'GT', name: 'Guatemala', flag: getFlagEmoji('GT') },
  { code: 'HN', name: 'Honduras', flag: getFlagEmoji('HN') },
  { code: 'HK', name: 'Hong Kong', flag: getFlagEmoji('HK') },
  { code: 'HU', name: 'Hungary', flag: getFlagEmoji('HU') },
  { code: 'IS', name: 'Iceland', flag: getFlagEmoji('IS') },
  { code: 'IN', name: 'India', flag: getFlagEmoji('IN') },
  { code: 'ID', name: 'Indonesia', flag: getFlagEmoji('ID') },
  { code: 'IR', name: 'Iran', flag: getFlagEmoji('IR') },
  { code: 'IQ', name: 'Iraq', flag: getFlagEmoji('IQ') },
  { code: 'IE', name: 'Ireland', flag: getFlagEmoji('IE') },
  { code: 'IL', name: 'Israel', flag: getFlagEmoji('IL') },
  { code: 'IT', name: 'Italy', flag: getFlagEmoji('IT') },
  { code: 'JM', name: 'Jamaica', flag: getFlagEmoji('JM') },
  { code: 'JP', name: 'Japan', flag: getFlagEmoji('JP') },
  { code: 'JO', name: 'Jordan', flag: getFlagEmoji('JO') },
  { code: 'KZ', name: 'Kazakhstan', flag: getFlagEmoji('KZ') },
  { code: 'KE', name: 'Kenya', flag: getFlagEmoji('KE') },
  { code: 'KR', name: 'South Korea', flag: getFlagEmoji('KR') },
  { code: 'KW', name: 'Kuwait', flag: getFlagEmoji('KW') },
  { code: 'LB', name: 'Lebanon', flag: getFlagEmoji('LB') },
  { code: 'LY', name: 'Libya', flag: getFlagEmoji('LY') },
  { code: 'MY', name: 'Malaysia', flag: getFlagEmoji('MY') },
  { code: 'MX', name: 'Mexico', flag: getFlagEmoji('MX') },
  { code: 'MA', name: 'Morocco', flag: getFlagEmoji('MA') },
  { code: 'NL', name: 'Netherlands', flag: getFlagEmoji('NL') },
  { code: 'NZ', name: 'New Zealand', flag: getFlagEmoji('NZ') },
  { code: 'NG', name: 'Nigeria', flag: getFlagEmoji('NG') },
  { code: 'NO', name: 'Norway', flag: getFlagEmoji('NO') },
  { code: 'OM', name: 'Oman', flag: getFlagEmoji('OM') },
  { code: 'PK', name: 'Pakistan', flag: getFlagEmoji('PK') },
  { code: 'PS', name: 'Palestine', flag: getFlagEmoji('PS') },
  { code: 'PA', name: 'Panama', flag: getFlagEmoji('PA') },
  { code: 'PE', name: 'Peru', flag: getFlagEmoji('PE') },
  { code: 'PH', name: 'Philippines', flag: getFlagEmoji('PH') },
  { code: 'PL', name: 'Poland', flag: getFlagEmoji('PL') },
  { code: 'PT', name: 'Portugal', flag: getFlagEmoji('PT') },
  { code: 'QA', name: 'Qatar', flag: getFlagEmoji('QA') },
  { code: 'RO', name: 'Romania', flag: getFlagEmoji('RO') },
  { code: 'RU', name: 'Russia', flag: getFlagEmoji('RU') },
  { code: 'SA', name: 'Saudi Arabia', flag: getFlagEmoji('SA') },
  { code: 'SN', name: 'Senegal', flag: getFlagEmoji('SN') },
  { code: 'RS', name: 'Serbia', flag: getFlagEmoji('RS') },
  { code: 'SG', name: 'Singapore', flag: getFlagEmoji('SG') },
  { code: 'ZA', name: 'South Africa', flag: getFlagEmoji('ZA') },
  { code: 'ES', name: 'Spain', flag: getFlagEmoji('ES') },
  { code: 'LK', name: 'Sri Lanka', flag: getFlagEmoji('LK') },
  { code: 'SD', name: 'Sudan', flag: getFlagEmoji('SD') },
  { code: 'SE', name: 'Sweden', flag: getFlagEmoji('SE') },
  { code: 'CH', name: 'Switzerland', flag: getFlagEmoji('CH') },
  { code: 'SY', name: 'Syria', flag: getFlagEmoji('SY') },
  { code: 'TW', name: 'Taiwan', flag: getFlagEmoji('TW') },
  { code: 'TH', name: 'Thailand', flag: getFlagEmoji('TH') },
  { code: 'TN', name: 'Tunisia', flag: getFlagEmoji('TN') },
  { code: 'TR', name: 'Turkey', flag: getFlagEmoji('TR') },
  { code: 'UA', name: 'Ukraine', flag: getFlagEmoji('UA') },
  { code: 'AE', name: 'United Arab Emirates', flag: getFlagEmoji('AE') },
  { code: 'GB', name: 'United Kingdom', flag: getFlagEmoji('GB') },
  { code: 'US', name: 'United States', flag: getFlagEmoji('US') },
  { code: 'UY', name: 'Uruguay', flag: getFlagEmoji('UY') },
  { code: 'VE', name: 'Venezuela', flag: getFlagEmoji('VE') },
  { code: 'VN', name: 'Vietnam', flag: getFlagEmoji('VN') },
  { code: 'YE', name: 'Yemen', flag: getFlagEmoji('YE') }
];

export const getCountryByName = (name: string): Country | undefined => {
  return COUNTRIES.find(c => c.name === name);
};

export const getCountryByCode = (code: string): Country | undefined => {
  return COUNTRIES.find(c => c.code === code);
};