import { test, expect } from '@playwright/test';

test.describe('Demo Shop Baseline Tests', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('1. Catalog renders title and product list', async ({ page }) => {
    await expect(page.getByTestId('shop-title')).toHaveText('Demo Gear Shop');
    await expect(page.getByTestId('product-card-prod-keyboard')).toBeVisible();
    await expect(page.getByTestId('product-price-prod-keyboard')).toHaveText('$100');
    await expect(page.getByTestId('product-card-prod-mouse')).toBeVisible();
    await expect(page.getByTestId('product-price-prod-mouse')).toHaveText('$20');
  });

  test('2. Sorts products numerically by price ascending', async ({ page }) => {
    const sortSelect = page.getByTestId('sort-select');
    await sortSelect.selectOption('price-asc');

    // Prices: Desk Mat ($15) -> Mouse ($20) -> Headset ($50) -> Keyboard ($100)
    const productTitles = page.locator('[data-testid^="product-title-"]');
    await expect(productTitles.first()).toHaveText('Desk Mat');
    await expect(productTitles.nth(1)).toHaveText('Ergonomic Mouse');
    await expect(productTitles.last()).toHaveText('Mechanical Keyboard');
  });

  test('3. Adds items to cart and updates cart counter', async ({ page }) => {
    await page.getByTestId('add-to-cart-prod-mouse').click();
    await page.getByTestId('add-to-cart-prod-keyboard').click();

    await expect(page.getByTestId('nav-cart')).toHaveText('Cart (2)');
    await page.getByTestId('nav-cart').click();

    await expect(page.getByTestId('cart-row-prod-mouse')).toBeVisible();
    await expect(page.getByTestId('cart-row-prod-keyboard')).toBeVisible();
    await expect(page.getByTestId('cart-total')).toHaveText('$120.00');
  });

  test('4. Modifying item quantity calculates correct subtotal', async ({ page }) => {
    await page.getByTestId('add-to-cart-prod-mouse').click(); // $20
    await page.getByTestId('nav-cart').click();

    const qtyInput = page.getByTestId('cart-item-qty-prod-mouse');
    await qtyInput.fill('3');

    await expect(page.getByTestId('cart-subtotal')).toHaveText('$60.00');
    await expect(page.getByTestId('cart-total')).toHaveText('$60.00');
  });

  test('5. Applies coupon SAVE10 once and avoids duplicate application', async ({ page }) => {
    await page.getByTestId('add-to-cart-prod-keyboard').click(); // $100
    await page.getByTestId('nav-cart').click();

    await page.getByTestId('coupon-input').fill('SAVE10');
    await page.getByTestId('apply-coupon-btn').click();

    // 10% off $100 = $10 discount -> Total $90
    await expect(page.getByTestId('cart-discount')).toHaveText('$10.00');
    await expect(page.getByTestId('cart-total')).toHaveText('$90.00');

    // Double clicking apply should not apply discount twice
    await page.getByTestId('apply-coupon-btn').click();
    await expect(page.getByTestId('cart-total')).toHaveText('$90.00');
  });

  test('6. Checkout validates email and displays confirmation', async ({ page }) => {
    await page.getByTestId('add-to-cart-prod-keyboard').click();
    await page.getByTestId('nav-cart').click();
    await page.getByTestId('proceed-to-checkout-btn').click();

    // Submit empty email
    await page.getByTestId('checkout-btn').click();
    await expect(page.getByTestId('checkout-error')).toBeVisible();

    // Submit valid email
    await page.getByTestId('checkout-email').fill('customer@example.com');
    await page.getByTestId('checkout-btn').click();

    await expect(page.getByTestId('order-confirmation')).toBeVisible();
    await expect(page.getByTestId('order-confirmation')).toContainText('customer@example.com');
  });
});
