import type { APIRequestContext } from '@playwright/test';
import { expect, makeAccount, makeDelegation, test } from './fixtures.js';

/**
 * Maximums.
 *
 * One sentence carries this feature, and it is the owner's own: a line capped at
 * $400, set to receive $200 a paycheck and already holding $275, takes **$125**
 * on the next press — and the other **$75 stays available to delegate**.
 *
 * The arithmetic is proved in `packages/shared` and the ledger in the API tests.
 * What a browser has to show is the part those cannot: that the ceiling can be
 * set where the line is, that the page says what it will do before it is saved,
 * and that a press actually moves the smaller figure while the budget's reading
 * keeps the difference.
 */

/** Everyday Checking with $1,000, and Car repairs holding $275 of it. */
async function landedPaycheck(api: APIRequestContext): Promise<void> {
  await makeAccount('Everyday Checking', 'asset', 100000n);
  const id = await makeDelegation(api, 'Car repairs', '20000');
  // Through the same endpoint the row uses, so the balance is a ledger event
  // rather than a number somebody set.
  await api.post(`/api/delegations/${id}/adjust`, { data: { deltaCents: '27500' } });
}

test('a maximum caps the press and leaves the rest to delegate', async ({ signedIn, api }) => {
  await landedPaycheck(api);
  await signedIn.goto('/budget');

  await signedIn.getByRole('button', { name: 'Options for Car repairs' }).click();
  await signedIn.getByRole('menuitem', { name: 'Set a maximum' }).click();

  await signedIn.getByLabel('Maximum', { exact: true }).fill('400.00');

  // The reading, live, before anything is saved — in this line's own figures,
  // and saying where the money that does not fit actually goes.
  const setting = signedIn.getByRole('dialog', { name: 'Set a maximum for Car repairs' });
  await expect(setting.getByText(/rather than \$200\.00/)).toBeVisible();
  await expect(setting.getByText(/\$75\.00 stays available to delegate/)).toBeVisible();

  await signedIn.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(signedIn.getByRole('dialog')).toHaveCount(0);

  /*
   * The amount to delegate is untouched — a maximum caps the balance, not the
   * figure the household typed — and the sentence saying what will happen sits
   * on that figure rather than beside the name, within reach of somebody who
   * never hovers anything.
   */
  const cell = signedIn.getByRole('button', { name: 'Car repairs amount to delegate' });
  await expect(cell).toContainText('$200.00');
  await expect(cell).toHaveAttribute('title', /Delegate adds \$125\.00 of this/);

  // The chip, for somebody passing over the row rather than reading the cell.
  await expect(signedIn.getByTitle('Has a maximum — Delegate stops at it')).toBeVisible();

  // And the press itself: the confirmation offers the capped total and says
  // what is being held back.
  await signedIn.getByRole('button', { name: 'Delegate', exact: true }).click();
  const dialog = signedIn.getByRole('dialog', { name: 'Confirm delegate' });
  await expect(dialog).toContainText('$125.00');
  await expect(dialog).toContainText('$75.00 is held back by a line at its maximum');

  await dialog.getByRole('button', { name: 'Delegate', exact: true }).click();

  await expect(signedIn.getByRole('button', { name: 'Car repairs balance' })).toContainText(
    '$400.00',
  );
  // $725 was undelegated before the press and $600 after it: down by the $125
  // that went in, not by the $200 the line is set to receive.
  await expect(signedIn.getByRole('status')).toContainText('To delegate $600.00');
});

test('a line already at its maximum receives nothing', async ({ signedIn, api }) => {
  await makeAccount('Everyday Checking', 'asset', 100000n);
  const id = await makeDelegation(api, 'Car repairs', '20000');
  await api.post(`/api/delegations/${id}/adjust`, { data: { deltaCents: '40000' } });
  await api.patch(`/api/delegations/${id}`, { data: { maxBalanceCents: '40000' } });

  await signedIn.goto('/budget');

  await signedIn.getByRole('button', { name: 'Options for Car repairs' }).click();
  await signedIn.getByRole('menuitem', { name: /Edit the maximum/ }).click();
  const setting = signedIn.getByRole('dialog', { name: 'Set a maximum for Car repairs' });
  await expect(setting.getByText(/already at its maximum/)).toBeVisible();
  await setting.getByRole('button', { name: 'Cancel' }).click();

  await signedIn.getByRole('button', { name: 'Delegate', exact: true }).click();
  const dialog = signedIn.getByRole('dialog', { name: 'Confirm delegate' });
  await expect(dialog).toContainText('$0.00');
  await dialog.getByRole('button', { name: 'Delegate', exact: true }).click();

  await expect(signedIn.getByRole('button', { name: 'Car repairs balance' })).toContainText(
    '$400.00',
  );
});

test('a maximum is removed from the same dialog', async ({ signedIn, api }) => {
  await landedPaycheck(api);
  await signedIn.goto('/budget');

  await signedIn.getByRole('button', { name: 'Options for Car repairs' }).click();
  await signedIn.getByRole('menuitem', { name: 'Set a maximum' }).click();
  await signedIn.getByLabel('Maximum', { exact: true }).fill('400.00');
  await signedIn.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(signedIn.getByRole('dialog')).toHaveCount(0);

  await signedIn.getByRole('button', { name: 'Options for Car repairs' }).click();
  await signedIn.getByRole('menuitem', { name: /Edit the maximum/ }).click();
  await signedIn.getByRole('button', { name: 'Remove' }).click();
  await expect(signedIn.getByRole('dialog')).toHaveCount(0);

  await expect(signedIn.getByTitle('Has a maximum — Delegate stops at it')).toHaveCount(0);
  await signedIn.getByRole('button', { name: 'Options for Car repairs' }).click();
  await expect(signedIn.getByRole('menuitem', { name: /Set a maximum/ })).toBeVisible();
});

/**
 * The band at the top of Overview and the Budget page draw the same table
 * (§11a), so the chip appears on both without a second rendering of it — which
 * is the whole reason the mark went into the shared vocabulary rather than onto
 * one screen.
 */
test('the chip reads the same in the Overview band', async ({ signedIn, api }) => {
  const id = await makeDelegation(api, 'Car repairs', '20000');
  await api.patch(`/api/delegations/${id}`, { data: { maxBalanceCents: '40000' } });

  await signedIn.goto('/overview');

  const panel = signedIn.getByRole('region', { name: 'Budget' });
  await panel.getByRole('button', { name: 'Select Delegations' }).click();
  const dialog = signedIn.getByRole('dialog');
  await dialog.getByRole('switch', { name: 'Show Car repairs' }).click();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toHaveCount(0);

  await expect(panel.getByTitle('Has a maximum — Delegate stops at it')).toBeVisible();
});
