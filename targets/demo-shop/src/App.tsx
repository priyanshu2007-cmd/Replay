import React, { useState, useEffect } from 'react';
import { Product, CartItem } from './types.js';
import { INITIAL_PRODUCTS } from './products.js';

export function App() {
  // Check if a deterministic bug is active via query param or env
  const activeBug =
    typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search).get('bug')
      : null;

  const [products, setProducts] = useState<Product[]>(INITIAL_PRODUCTS);
  const [sortBy, setSortBy] = useState<'none' | 'price-asc' | 'price-desc'>('none');
  const [cart, setCart] = useState<CartItem[]>(() => {
    try {
      if (activeBug === 'quantity-reset') return [];
      const saved = localStorage.getItem('replay_demo_cart');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });
  const [couponCode, setCouponCode] = useState('');
  const [appliedCoupon, setAppliedCoupon] = useState<string | null>(null);
  const [discountPercent, setDiscountPercent] = useState<number>(0);
  const [email, setEmail] = useState('');
  const [checkoutError, setCheckoutError] = useState('');
  const [orderConfirmed, setOrderConfirmed] = useState(false);
  const [activeTab, setActiveTab] = useState<'shop' | 'cart' | 'checkout'>('shop');

  // Multi-page navigation persistence simulation
  useEffect(() => {
    if (activeBug === 'quantity-reset') return;
    try {
      localStorage.setItem('replay_demo_cart', JSON.stringify(cart));
    } catch {
      // Ignore in restricted environments
    }
  }, [cart, activeBug]);

  const handleTabChange = (tab: 'shop' | 'cart' | 'checkout') => {
    if (activeBug === 'quantity-reset' && tab === 'cart') {
      // Bug: Navigating back to cart resets quantities to 1
      setCart((prev) => prev.map((item) => ({ ...item, quantity: 1 })));
    }
    setActiveTab(tab);
  };

  const handleSortChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value as 'none' | 'price-asc' | 'price-desc';
    setSortBy(val);

    const sorted = [...INITIAL_PRODUCTS];
    if (val === 'price-asc') {
      if (activeBug === 'string-sort') {
        // BUG 3: Lexicographical string sort places "100" before "20"
        sorted.sort((a, b) => String(a.price).localeCompare(String(b.price)));
      } else {
        // Baseline: numerical sort
        sorted.sort((a, b) => a.price - b.price);
      }
    } else if (val === 'price-desc') {
      if (activeBug === 'string-sort') {
        sorted.sort((a, b) => String(b.price).localeCompare(String(a.price)));
      } else {
        sorted.sort((a, b) => b.price - a.price);
      }
    }
    setProducts(sorted);
  };

  const addToCart = (product: Product) => {
    setCart((prev) => {
      const existing = prev.find((item) => item.product.id === product.id);
      if (existing) {
        return prev.map((item) =>
          item.product.id === product.id ? { ...item, quantity: item.quantity + 1 } : item
        );
      }
      return [...prev, { product, quantity: 1 }];
    });
  };

  const handleQuantityChange = (productId: string, rawValue: string) => {
    if (activeBug === 'cart-nan') {
      // BUG 1: Unvalidated parseInt on empty string produces NaN in state
      const qty = parseInt(rawValue, 10);
      setCart((prev) =>
        prev.map((item) => (item.product.id === productId ? { ...item, quantity: qty } : item))
      );
      return;
    }

    // Baseline: safe integer parsing
    let qty = parseInt(rawValue, 10);
    if (isNaN(qty) || qty < 0) {
      qty = 0;
    }

    setCart((prev) =>
      prev
        .map((item) => (item.product.id === productId ? { ...item, quantity: qty } : item))
        .filter((item) => item.quantity > 0)
    );
  };

  const handleApplyCoupon = () => {
    const code = couponCode.trim().toUpperCase();

    if (activeBug === 'double-discount') {
      // BUG 2: No idempotency check; double clicking stacks discounts
      if (code === 'SAVE10') {
        setAppliedCoupon(code);
        setDiscountPercent((prev) => prev + 10);
      }
      return;
    }

    // Baseline: prevent duplicate application
    if (appliedCoupon === code) {
      return;
    }

    if (code === 'SAVE10') {
      setAppliedCoupon(code);
      setDiscountPercent(10);
    } else if (code === 'SAVE20') {
      setAppliedCoupon(code);
      setDiscountPercent(20);
    } else {
      alert('Invalid coupon code. Try SAVE10');
    }
  };

  const handleCheckout = (e: React.FormEvent) => {
    e.preventDefault();

    if (activeBug === 'empty-email') {
      // BUG 4: Omit email validation completely
      setCheckoutError('');
      setOrderConfirmed(true);
      setCart([]);
      return;
    }

    // Baseline validation: email cannot be empty
    if (!email.trim() || !email.includes('@')) {
      setCheckoutError('Please provide a valid email address.');
      return;
    }
    setCheckoutError('');
    setOrderConfirmed(true);
    setCart([]);
    try {
      localStorage.removeItem('replay_demo_cart');
    } catch {}
  };

  const subtotal = cart.reduce((sum, item) => sum + item.product.price * item.quantity, 0);
  const discountAmount = Number(((subtotal * discountPercent) / 100).toFixed(2));
  const finalTotal = Number((subtotal - discountAmount).toFixed(2));

  return (
    <div style={{ maxWidth: '900px', margin: '0 auto', padding: '24px', fontFamily: 'sans-serif' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
        <h1 data-testid="shop-title">Demo Gear Shop</h1>
        <nav style={{ display: 'flex', gap: '12px' }}>
          <button data-testid="nav-shop" onClick={() => handleTabChange('shop')}>
            Catalog
          </button>
          <button data-testid="nav-cart" onClick={() => handleTabChange('cart')}>
            Cart ({cart.reduce((c, i) => c + (isNaN(i.quantity) ? 0 : i.quantity), 0)})
          </button>
          <button data-testid="nav-checkout" onClick={() => handleTabChange('checkout')}>
            Checkout
          </button>
        </nav>
      </header>

      {orderConfirmed ? (
        <div data-testid="order-confirmation" style={{ padding: '32px', background: '#ecfdf5', borderRadius: '8px' }}>
          <h2>Order Confirmed!</h2>
          <p>Confirmation sent to: <strong>{email || '(no email provided)'}</strong></p>
          <button data-testid="continue-shopping-btn" onClick={() => { setOrderConfirmed(false); handleTabChange('shop'); }}>
            Continue Shopping
          </button>
        </div>
      ) : (
        <>
          {activeTab === 'shop' && (
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                <h2>Products</h2>
                <label>
                  Sort by:{' '}
                  <select data-testid="sort-select" value={sortBy} onChange={handleSortChange}>
                    <option value="none">Featured</option>
                    <option value="price-asc">Price: Low to High</option>
                    <option value="price-desc">Price: High to Low</option>
                  </select>
                </label>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '16px' }}>
                {products.map((p) => (
                  <div
                    key={p.id}
                    data-testid={`product-card-${p.id}`}
                    style={{ border: '1px solid #e5e7eb', borderRadius: '8px', padding: '16px' }}
                  >
                    <h3 data-testid={`product-title-${p.id}`}>{p.name}</h3>
                    <p style={{ color: '#6b7280', fontSize: '14px' }}>{p.description}</p>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '12px' }}>
                      <span data-testid={`product-price-${p.id}`} style={{ fontWeight: 'bold' }}>
                        ${p.price}
                      </span>
                      <button data-testid={`add-to-cart-${p.id}`} onClick={() => addToCart(p)}>
                        Add to Cart
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeTab === 'cart' && (
            <div data-testid="cart-container">
              <h2>Your Cart</h2>
              {cart.length === 0 ? (
                <p data-testid="empty-cart-message">Your cart is empty.</p>
              ) : (
                <div>
                  <table style={{ width: '100%', textAlign: 'left', borderCollapse: 'collapse', marginBottom: '16px' }}>
                    <thead>
                      <tr style={{ borderBottom: '2px solid #e5e7eb' }}>
                        <th style={{ padding: '8px' }}>Product</th>
                        <th style={{ padding: '8px' }}>Price</th>
                        <th style={{ padding: '8px' }}>Quantity</th>
                        <th style={{ padding: '8px' }}>Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {cart.map((item) => (
                        <tr key={item.product.id} data-testid={`cart-row-${item.product.id}`} style={{ borderBottom: '1px solid #e5e7eb' }}>
                          <td style={{ padding: '8px' }}>{item.product.name}</td>
                          <td style={{ padding: '8px' }}>${item.product.price}</td>
                          <td style={{ padding: '8px' }}>
                            <input
                              type="number"
                              data-testid={`cart-item-qty-${item.product.id}`}
                              value={isNaN(item.quantity) ? '' : item.quantity}
                              onChange={(e) => handleQuantityChange(item.product.id, e.target.value)}
                              style={{ width: '60px' }}
                            />
                          </td>
                          <td style={{ padding: '8px' }}>
                            ${isNaN(item.quantity) ? 'NaN' : item.product.price * item.quantity}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>

                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', background: '#f9fafb', padding: '16px', borderRadius: '8px' }}>
                    <div>
                      <h4>Promo Code</h4>
                      <div style={{ display: 'flex', gap: '8px' }}>
                        <input
                          type="text"
                          data-testid="coupon-input"
                          placeholder="e.g. SAVE10"
                          value={couponCode}
                          onChange={(e) => setCouponCode(e.target.value)}
                        />
                        <button data-testid="apply-coupon-btn" onClick={handleApplyCoupon}>
                          Apply
                        </button>
                      </div>
                      {appliedCoupon && (
                        <p data-testid="coupon-status" style={{ color: '#059669', fontSize: '14px', marginTop: '4px' }}>
                          Applied: {appliedCoupon} ({discountPercent}% OFF)
                        </p>
                      )}
                    </div>

                    <div style={{ textAlign: 'right' }}>
                      <p>Subtotal: <span data-testid="cart-subtotal">${isNaN(subtotal) ? 'NaN' : subtotal.toFixed(2)}</span></p>
                      {discountAmount > 0 && (
                        <p style={{ color: '#059669' }}>Discount: -<span data-testid="cart-discount">${discountAmount.toFixed(2)}</span></p>
                      )}
                      <h3>Total: <span data-testid="cart-total">${isNaN(finalTotal) ? 'NaN' : finalTotal.toFixed(2)}</span></h3>
                      <button data-testid="proceed-to-checkout-btn" onClick={() => handleTabChange('checkout')}>
                        Proceed to Checkout
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {activeTab === 'checkout' && (
            <div data-testid="checkout-container" style={{ maxWidth: '400px' }}>
              <h2>Checkout</h2>
              <form onSubmit={handleCheckout}>
                <div style={{ marginBottom: '16px' }}>
                  <label style={{ display: 'block', marginBottom: '4px' }}>Email Address:</label>
                  <input
                    type="email"
                    data-testid="checkout-email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    style={{ width: '100%', padding: '8px' }}
                  />
                  {checkoutError && (
                    <p data-testid="checkout-error" style={{ color: '#dc2626', fontSize: '14px', marginTop: '4px' }}>
                      {checkoutError}
                    </p>
                  )}
                </div>
                <div style={{ marginBottom: '16px' }}>
                  <p>Order Total: <strong>${isNaN(finalTotal) ? 'NaN' : finalTotal.toFixed(2)}</strong></p>
                </div>
                <button type="submit" data-testid="checkout-btn" style={{ width: '100%', padding: '10px' }}>
                  Complete Purchase
                </button>
              </form>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default App;
