module.exports = {
  version: 2,
  prices: { sandwich: 10 },
  // comboDiscount: ₪ off for every sandwich+drink pair (0 = off). loyaltyGoal: sandwiches per free one (0 = off).
  promos: { comboDiscount: 2, loyaltyGoal: 10 },
  breads: [
    { id: 'pita', name: 'פיתה', img: '/img/pita.webp', available: true },
    { id: 'roll8', name: 'לחמניה שמונה', img: '/img/roll8.webp', available: true },
    { id: 'sourdough', name: 'לחם מחמצת', img: '/img/sourdough.webp', available: true },
  ],
  spreads: [
    { id: 'pesto', name: 'פסטו', img: '/img/pesto.webp', available: true },
    { id: 'cream-cheese', name: 'גבינת שמנת', img: '/img/cream-cheese.webp', available: true },
    { id: 'spicy', name: 'חריף', img: '/img/spicy.webp', available: true },
    { id: 'mayo', name: 'מיונז', img: '/img/mayo.webp', available: true },
  ],
  vegetables: [
    { id: 'tomato', name: 'עגבנייה', img: '/img/tomato.webp', available: true },
    { id: 'cucumber', name: 'מלפפון', img: '/img/cucumber.webp', available: true },
    { id: 'onion', name: 'בצל', img: '/img/onion.webp', available: true },
    { id: 'eggplant', name: 'חציל', img: '/img/eggplant.webp', available: true },
  ],
  fillings: [
    { id: 'tuna', name: 'טונה', img: '/img/tuna.webp', available: true },
    { id: 'omelette', name: 'חביתה', img: '/img/omelette.webp', available: true },
    { id: 'shakshuka', name: 'שקשוקה', img: '/img/shakshuka.webp', available: true },
    { id: 'sabich', name: 'סביח', img: '/img/sabich.webp', available: true },
  ],
  extras: [
    { id: 'avocado', name: 'אבוקדו', price: 4, img: '/img/avocado.webp', available: true },
    { id: 'egg', name: 'ביצה קשה', price: 3, img: '/img/egg.webp', available: true },
    { id: 'olives', name: 'זיתים', price: 2, img: '/img/olives.webp', available: true },
    { id: 'pickles', name: 'חמוצים', price: 2, img: '/img/pickles.webp', available: true },
  ],
  drinks: [
    { id: 'iced-coffee', name: 'אייס קפה', price: 8, img: '/img/iced-coffee.webp', available: true },
    { id: 'cola', name: 'קולה', price: 6, img: '/img/cola.webp', available: true },
    { id: 'water', name: 'מים', price: 6, img: '/img/water.webp', available: true },
    { id: 'soda', name: 'סודה', price: 6, img: '/img/soda.webp', available: true },
  ],
};
