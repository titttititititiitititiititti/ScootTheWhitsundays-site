// The rental agreement the customer signs. Kept on the server so the exact
// wording they agreed to is saved with their booking. If you change the
// wording, bump AGREEMENT_VERSION so old bookings still show what they signed.
import { booking as site } from './config.js';

export const AGREEMENT_VERSION = '2026-11-self-service-4';

const money = (cents) => `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)} AUD`;
const longDate = (iso) =>
  new Date(iso + 'T00:00:00Z').toLocaleDateString('en-AU', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  });

/** Agreement sections for a given quote (from pricing.quote). */
export function buildAgreement(q) {
  const many = q.count > 1;
  const it = many ? 'the scooters are' : 'the scooter is';
  const bondHow = q.bondMethod === 'hold'
    ? `held on my card (not charged) and released after ${it} returned in the same condition`
    : `charged to my card and refunded after ${it} returned in the same condition`;
  const what = many ? `${q.count} scooters` : '1 scooter';
  const trips = [q.delivery && 'delivery', q.collection && 'collection'].filter(Boolean).join(' and ');
  const deliveryText = q.deliveryTotal ? `, plus ${money(q.deliveryTotal)} for ${trips}` : '';
  const bondText = many ? `a ${money(q.bond)} bond (${money(q.bondEach)} per scooter)` : `a ${money(q.bond)} bond`;
  return [
    {
      title: 'Payment',
      items: [
        { id: 'agreePayment', text: `I agree to pay a rental fee of ${money(q.rent)} for ${what} for ${q.days} day${q.days === 1 ? '' : 's'} (${longDate(q.start)} to ${longDate(q.end)})${deliveryText}, paid online now, plus ${bondText} that will be ${bondHow}.` },
        { id: 'agreeReturn', text: q.collection
          ? `I will have ${many ? 'every scooter, with its key,' : 'the scooter and key'} ready for collection at my address by ${site.returnByTime} on ${longDate(q.end)}, and stay responsible for ${many ? 'them' : 'it'} until collected.`
          : `I will return ${many ? 'every scooter' : 'the scooter'} to the pickup carport and put ${many ? 'each key back in its' : 'the key back in the'} same lockbox by ${site.returnByTime} on ${longDate(q.end)}.` },
        { id: 'agreeVideos', text: `I will upload a short video of ${many ? 'each scooter' : 'the scooter'} at pickup and at return using my booking link. I understand the bond may be used to cover damage, fines or losses found at return.` },
        { id: 'agreeArea', text: `${site.ridingArea.summary} ${site.ridingArea.noGo.join(' ')} I understand that damage caused by riding in these areas will be taken from the bond.` },
        { id: 'agreeOnePerson', text: `Each scooter will carry one person only, unless its rider holds a valid motorcycle licence (then one passenger is allowed).` },
        ...(many ? [{ id: 'agreeGroup', text: `I am responsible for all ${q.count} scooters in this booking, including every rider's use of them.` }] : []),
      ],
    },
    {
      title: 'Important declarations',
      items: [
        { id: 'declareTrue', text: 'I confirm that all information provided above is true and correct.' },
        { id: 'declareLicence', text: 'I confirm that every rider holds a valid licence and is legally allowed to ride the scooter they will use in Queensland (a car licence covers 50cc scooters; a scooter over 50cc needs a motorcycle licence), and that the licence photos I have uploaded belong to the riders.' },
        { id: 'declareFalse', text: 'I understand that providing false or misleading information may void insurance coverage and result in full personal liability.' },
        { id: 'declareDamage', text: 'I understand that I am financially responsible for any damage, fines, or losses not covered by insurance.' },
        { id: 'declareRide', text: 'I agree to ride the scooter responsibly and in accordance with Queensland road laws.' },
      ],
    },
    {
      title: 'Signature',
      items: [
        { id: 'agreeBinding', text: 'By typing my name as my signature, I acknowledge this form constitutes a legally binding declaration.' },
      ],
    },
  ];
}

export const allItemIds = (sections) => sections.flatMap((s) => s.items.map((i) => i.id));
