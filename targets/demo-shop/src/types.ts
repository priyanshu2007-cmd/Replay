export interface Product {
  id: string;
  name: string;
  price: number;
  description: string;
  category: string;
}

export interface CartItem {
  product: Product;
  quantity: number;
}

export interface Discount {
  code: string;
  percent: number;
}
