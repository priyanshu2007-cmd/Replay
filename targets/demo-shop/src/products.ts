import { Product } from './types.js';

export const INITIAL_PRODUCTS: Product[] = [
  {
    id: 'prod-keyboard',
    name: 'Mechanical Keyboard',
    price: 100,
    description: 'Tactile switches with RGB backlight.',
    category: 'Peripherals',
  },
  {
    id: 'prod-mouse',
    name: 'Ergonomic Mouse',
    price: 20,
    description: 'Wireless optical mouse with thumb grip.',
    category: 'Peripherals',
  },
  {
    id: 'prod-pad',
    name: 'Desk Mat',
    price: 15,
    description: 'Smooth microfiber cloth desk pad.',
    category: 'Accessories',
  },
  {
    id: 'prod-headset',
    name: 'Studio Headset',
    price: 50,
    description: 'Noise-isolating over-ear headphones.',
    category: 'Audio',
  },
];
