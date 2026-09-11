import type { ReactNode } from 'react';
import { BitcoinSection } from './Bitcoin.jsx';
import { BudgetSection } from './Budget.jsx';
import { DelegationsSection } from './Delegations.jsx';
import { GroupingsSection } from './Groupings.jsx';
import { HiddenBillsSection } from './HiddenBills.jsx';
import { PropertiesSection } from './Properties.jsx';
import { TorSection } from './Tor.jsx';
import { TwoFactorCard } from './TwoFactor.jsx';
import { UsersSection, YourAccount } from './Users.jsx';

/**
 * The three sections that are several of the old ones.
 *
 * Settings had twelve tabs and half of them held a single card, which made the
 * row a list of words to read rather than a set of places to go. These compose
 * what was already there rather than rewriting it: each card is the same
 * component, in the same order it had, under a heading that says what somebody
 * came to change.
 *
 * The groupings are by **question**, not by table:
 *
 * - **Budget** is how the envelopes are shaped — the tolerance and the cadence,
 *   the delegations themselves, the groupings they sit in, and the merchants
 *   somebody has said are not bills. Somebody adding a line and somebody filing
 *   it are the same person a second apart, and what the register *infers* is
 *   corrected in the same place its notifications are switched.
 * - **Holdings** is what the household owns that no feed reports: Bitcoin, the
 *   node it is read from, and property. [ADR 021](../../../../../docs/decisions/021-bitcoin-and-property-are-managed-where-they-live.md)
 *   moved these off the Accounts *list* because creating one there produced a
 *   holding that contributed nothing to the identity. They keep their own cards
 *   and their own create flows; only the tab they share has changed.
 * - **Access** is who gets in and how — the household's accounts, your own
 *   credentials, and the onion service.
 */

export function BudgetGroupSection(): ReactNode {
  return (
    <>
      <BudgetSection />
      {/* Delegations and Groupings share a row and have since v0.49 — anything
          inserted between them takes half of it and pushes Groupings onto a row
          of its own. Hidden bills goes after them, on a third of the next. */}
      <DelegationsSection />
      <GroupingsSection />
      <HiddenBillsSection />
    </>
  );
}

export function HoldingsSection(): ReactNode {
  return (
    <>
      <BitcoinSection />
      <PropertiesSection />
    </>
  );
}

export function AccessSection(): ReactNode {
  return (
    <>
      {/*
        Three about getting in, then two about who has been.
        
        The order is the layout: `YourAccount`, two-factor and the onion service
        are each a third of a row, and the two tables under them are halves. A
        section that rendered all five in one fixed block could not be arranged
        this way, which is why the cards above are separate exports.
      */}
      <YourAccount />
      <TwoFactorCard />
      <TorSection />
      <UsersSection />
    </>
  );
}
