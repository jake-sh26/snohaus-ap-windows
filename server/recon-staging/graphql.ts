/**
 * Shopify GraphQL queries used by the staging harness.
 *
 * These are intentionally separate from the existing ORDERS_QUERY in
 * server/shopify-recon-orders.ts so the harness can evolve without risk
 * to production ingest. We pull MORE fields here than the production
 * ingest needs — current+original totals, taxLines, shippingLines,
 * channelInformation, physicalLocation, fulfillments, events for edits,
 * refunds and their line items with refundable_quantity etc.
 *
 * Pagination: cursor-based over `orders(first: 100, query: ...)`.
 */

export const SHOP_INFO_QUERY = /* GraphQL */ `
  query ShopInfo {
    shop {
      id
      name
      myshopifyDomain
      ianaTimezone
      currencyCode
    }
  }
`;

/**
 * Filter syntax for the `query:` argument:
 *   processed_at:>=YYYY-MM-DD processed_at:<YYYY-MM-DD
 *
 * We page by processed_at (sale recognition date) because the harness's
 * primary grouping is the sale's processed_at in shop-local time. Refunds
 * processed in a later month against orders from this month are pulled
 * via the `refunds-in-month` second pass below.
 */
export const ORDERS_BY_PROCESSED_AT_QUERY = /* GraphQL */ `
  query OrdersByProcessedAt($cursor: String, $q: String!) {
    orders(first: 50, after: $cursor, query: $q, sortKey: PROCESSED_AT) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        name
        legacyResourceId
        createdAt
        processedAt
        updatedAt
        cancelledAt
        closedAt
        currencyCode
        displayFinancialStatus
        displayFulfillmentStatus
        cancelReason
        channelInformation {
          channelDefinition { handle channelName }
        }
        physicalLocation { id name }
        fulfillments(first: 20) {
          id
          status
          createdAt
          location { id name }
        }
        # ORIGINAL totals — locked at order creation
        originalTotalPriceSet         { shopMoney { amount currencyCode } }
        subtotalPriceSet              { shopMoney { amount currencyCode } }
        totalTaxSet                   { shopMoney { amount currencyCode } }
        totalDiscountsSet             { shopMoney { amount currencyCode } }
        totalShippingPriceSet         { shopMoney { amount currencyCode } }
        # CURRENT totals — mutate after returns/edits
        currentSubtotalPriceSet       { shopMoney { amount currencyCode } }
        currentTotalPriceSet          { shopMoney { amount currencyCode } }
        currentTotalTaxSet            { shopMoney { amount currencyCode } }
        currentTotalDiscountsSet      { shopMoney { amount currencyCode } }
        totalRefundedSet              { shopMoney { amount currencyCode } }
        totalOutstandingSet           { shopMoney { amount currencyCode } }
        # Line items
        lineItems(first: 100) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            sku
            title
            quantity
            currentQuantity
            refundableQuantity
            requiresShipping
            product { id productType vendor }
            variant { id sku }
            originalUnitPriceSet  { shopMoney { amount currencyCode } }
            discountedUnitPriceSet{ shopMoney { amount currencyCode } }
            originalTotalSet      { shopMoney { amount currencyCode } }
            discountedTotalSet    { shopMoney { amount currencyCode } }
            totalDiscountSet      { shopMoney { amount currencyCode } }
            taxLines {
              title
              rate
              priceSet { shopMoney { amount } }
            }
          }
        }
        # Shipping lines
        shippingLines(first: 20) {
          nodes {
            id
            title
            code
            originalPriceSet   { shopMoney { amount } }
            discountedPriceSet { shopMoney { amount } }
            taxLines {
              title
              rate
              priceSet { shopMoney { amount } }
            }
          }
        }
        # Order-level discount applications
        discountApplications(first: 20) {
          nodes {
            ... on AutomaticDiscountApplication {
              title
              allocationMethod
              targetSelection
              targetType
              value {
                ... on MoneyV2 { amount currencyCode }
                ... on PricingPercentageValue { percentage }
              }
            }
            ... on DiscountCodeApplication {
              code
              allocationMethod
              targetSelection
              targetType
              value {
                ... on MoneyV2 { amount currencyCode }
                ... on PricingPercentageValue { percentage }
              }
            }
            ... on ManualDiscountApplication {
              title
              description
              allocationMethod
              targetSelection
              targetType
              value {
                ... on MoneyV2 { amount currencyCode }
                ... on PricingPercentageValue { percentage }
              }
            }
            ... on ScriptDiscountApplication {
              title
              allocationMethod
              targetSelection
              targetType
              value {
                ... on MoneyV2 { amount currencyCode }
                ... on PricingPercentageValue { percentage }
              }
            }
          }
        }
        # Refunds — each with full line breakdown
        refunds(first: 50) {
          id
          legacyResourceId
          createdAt
          processedAt
          note
          totalRefundedSet { shopMoney { amount } }
          refundLineItems(first: 100) {
            nodes {
              quantity
              restockType
              subtotalSet { shopMoney { amount } }
              totalTaxSet { shopMoney { amount } }
              lineItem {
                id
                sku
                title
                product { productType }
              }
            }
          }
          orderAdjustments(first: 20) {
            nodes {
              id
              kind
              reason
              amountSet { shopMoney { amount } }
              taxAmountSet { shopMoney { amount } }
            }
          }
          transactions(first: 20) {
            nodes {
              id
              kind
              status
              processedAt
              amountSet { shopMoney { amount } }
            }
          }
        }
        # Edit events
        events(first: 50, query: "verb:edited OR verb:added_line_item OR verb:removed_line_item OR verb:updated_discount") {
          nodes {
            id
            createdAt
            message
            attributeToApp
            attributeToUser
          }
        }
      }
    }
  }
`;

/**
 * Fallback paginator for an order whose lineItems list exceeds 100.
 * Same shape as the inline lineItems block above. Used for the rare
 * order with >100 lines.
 */
export const ORDER_LINEITEMS_PAGED_QUERY = /* GraphQL */ `
  query OrderLineItemsPaged($orderId: ID!, $cursor: String) {
    order(id: $orderId) {
      id
      lineItems(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          sku
          title
          quantity
          currentQuantity
          refundableQuantity
          requiresShipping
          product { id productType vendor }
          variant { id sku }
          originalUnitPriceSet  { shopMoney { amount currencyCode } }
          discountedUnitPriceSet{ shopMoney { amount currencyCode } }
          originalTotalSet      { shopMoney { amount currencyCode } }
          discountedTotalSet    { shopMoney { amount currencyCode } }
          totalDiscountSet      { shopMoney { amount currencyCode } }
          taxLines {
            title
            rate
            priceSet { shopMoney { amount } }
          }
        }
      }
    }
  }
`;
