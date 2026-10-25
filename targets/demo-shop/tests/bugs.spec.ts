import { test, expect } from '@playwright/test';

test.describe('Demo Shop Bug Reproduction Fixtures', () => {
  test('Bug 1: cart total becomes NaN after clearing quantity field', async ({ page }) => {
    await page.goto('/?bug=cart-nan');
    await page.getByTestId('add-to-cart-prod-mouse').click();
    await page.getByTestId('nav-cart').click();

    const qtyInput = page.getByTestId('cart-item-qty-prod-mouse');
    await qtyInput.fill(''); // Clear field

    // Demonstrates the defect: Total shows $NaN
    await expect(page.getByTestId('cart-total')).toHaveText('$NaN');
  });

  test('Bug 2: double-clicking Apply applies discount twice', async ({ page }) => {
    await page.goto('/?bug=double-discount');
    await page.getByTestId('add-to-cart-prod-keyboard').click(); // $100
    await page.getByTestId('nav-cart').click();

    await page.getByTestId('coupon-input').fill('SAVE10');
    await page.getByTestId('apply-coupon-btn').click();
    await page.getByTestId('apply-coupon-btn').click(); // Second click

    // Demonstrates the defect: 20% off $100 = $80 total instead of $90
    await expect(page.getByTestId('cart-discount')).toHaveText('$20.00');
    await expect(page.getByTestId('cart-total')).toHaveText('$80.00');
  });

  test('Bug 3: string-based sort places $100 before $20', async ({ page }) => {
    await page.goto('/?bug=string-sort');
    const sortSelect = page.getByTestId('sort-select');
    await sortSelect.selectOption('price-asc');

    // Demonstrates defect: "100" (Keyboard) sorted first, before "15" (Desk Mat) and "20" (Mouse)
    const productTitles = page.locator('[data-testid^="product-title-"]');
    await expect(productTitles.first()).toHaveText('Mechanical Keyboard'); // $100 is first in string sort
    await expect(productTitles.nth(1)).toHaveText('Desk Mat'); // $15 is second in string sort
    await expect(productTitles.nth(2)).toHaveText('Ergonomic Mouse'); // $20 is third in string sort
  });

  test('Bug 4: checkout accepts empty email', async ({ page }) => {
    await page.goto('/?bug=empty-email');
    await page.getByTestId('add-to-cart-prod-mouse').click();
    await page.getByTestId('nav-cart').click();
    await page.getByTestId('proceed-to-checkout-btn').click();

    // Click checkout with empty email
    await page.getByTestId('checkout-btn').click();

    // Demonstrates defect: Order confirmed with empty email
    await expect(page.getByTestId('order-confirmation')).toBeVisible();
    await expect(page.getByTestId('checkout-error')).not.toBeVisible();
  });

  test('Bug 5: quantity resets after page navigation', async ({ page }) => {
    await page.goto('/?bug=quantity-reset');
    await page.getByTestId('add-to-cart-prod-mouse').click();
    await page.getByTestId('nav-cart').click();

    // Set quantity to 5
    await page.getByTestId('cart-item-qty-prod-mouse').fill('5');
    await expect(page.getByTestId('cart-total')).toHaveText('$100.00');

    // Navigate to Catalog and back to Cart
    await page.getByTestId('nav-shop').click();
    await page.getByTestId('nav-cart').click();

    // Demonstrates defect: Quantity reset to 1, total is $20 instead of $100
    await expect(page.getByTestId('cart-item-qty-prod-mouse')).toHaveValue('1');
    await expect(page.getByTestId('cart-total')).toHaveText('$20.00');
  });
});
