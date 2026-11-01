const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");
require("dotenv").config();

const app = express();

app.use(cors({ origin: "*" }));

// ================= WEBHOOK (MUST BE BEFORE express.json) =================
app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    // Only process events actually signed by the configured Stripe endpoint.
    const event = stripe.webhooks.constructEvent(
      req.body,
      req.headers["stripe-signature"],
      process.env.STRIPE_WEBHOOK_SECRET
    );

    console.log("WEBHOOK RECEIVED:", event.type);

    if (event.type === "checkout.session.completed") {
        const checkoutSession = event.data.object;

        if (
            checkoutSession.mode === "payment" &&
            checkoutSession.metadata?.type === "custom_build_deposit"
        ) {
            const orderRef = db.collection("orders").doc(checkoutSession.id);

            const fullDepositSession = await stripe.checkout.sessions.retrieve(checkoutSession.id, {
                expand: ["payment_intent.latest_charge"]
            });

            const depositChargeId =
                typeof fullDepositSession.payment_intent?.latest_charge === "object"
                    ? fullDepositSession.payment_intent.latest_charge.id
                    : "";

            await orderRef.set({
                userId: checkoutSession.metadata.userId || "",
                userEmail: checkoutSession.metadata.email || "",
                fullName: checkoutSession.metadata.fullName || "",
                phone: checkoutSession.metadata.phone || "",

                orderType: "custom_build_deposit",
                pcName: "Custom PC Build Request",

                gpu: checkoutSession.metadata.gpu || "",
                cpu: checkoutSession.metadata.cpu || "",
                motherboard: checkoutSession.metadata.motherboard || "",
                ram: checkoutSession.metadata.ram || "",
                storage: checkoutSession.metadata.storage || "",
                cooler: checkoutSession.metadata.cooler || "",
                case: checkoutSession.metadata.case || "",
                psu: checkoutSession.metadata.psu || "",

                pcpartpickerLink: checkoutSession.metadata.pcpartpickerLink || "",
                notes: checkoutSession.metadata.notes || "",

                depositPaid: true,
                depositAmount: Number(checkoutSession.amount_total || 0) / 100,
                stripeSessionId: checkoutSession.id,
                depositChargeId,
                depositRefunded: false,
                depositRefundAmount: 0,         

                status: "pending",
                paymentStatus: "deposit_paid",
                emailSent: true,
                emailSentAt: admin.firestore.FieldValue.serverTimestamp(),

                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });

            console.log("Custom build order created:", checkoutSession.id);

            try {
                await sendCustomBuildOrderEmail(
                    {
                        userEmail: checkoutSession.metadata.email || "",
                        fullName: checkoutSession.metadata.fullName || "",
                        gpu: checkoutSession.metadata.gpu || "",
                        cpu: checkoutSession.metadata.cpu || "",
                        motherboard: checkoutSession.metadata.motherboard || "",
                        ram: checkoutSession.metadata.ram || "",
                        storage: checkoutSession.metadata.storage || "",
                        cooler: checkoutSession.metadata.cooler || "",
                        case: checkoutSession.metadata.case || "",
                        psu: checkoutSession.metadata.psu || "",
                        pcpartpickerLink: checkoutSession.metadata.pcpartpickerLink || "",
                        notes: checkoutSession.metadata.notes || "",
                        depositAmount: Number(checkoutSession.amount_total || 0) / 100
                    },
                    checkoutSession.id
                );

                console.log("CUSTOM BUILD EMAIL SENT TO:", checkoutSession.metadata.email);
            } catch (emailErr) {
                console.error("CUSTOM BUILD EMAIL ERROR:", emailErr);
            }
        }

        if (
            checkoutSession.mode === "payment" &&
            checkoutSession.metadata?.type === "buyout" &&
            checkoutSession.metadata?.orderId
        ) {
            const orderRef = db.collection("orders").doc(checkoutSession.metadata.orderId);
            const orderSnap = await orderRef.get();

            if (orderSnap.exists) {
                await orderRef.update({
                    buyoutPaid: true,
                    buyoutPaidAt: admin.firestore.FieldValue.serverTimestamp(),
                    buyoutSessionId: checkoutSession.id,

                    // Actual Stripe amount paid
                    buyoutAmountPaid: Number(checkoutSession.amount_total || 0) / 100,

                    // Your calculated custom buyout amount
                    customBuyoutAmount: Number(checkoutSession.metadata.buyoutAmount || 0),

                    buyoutMonthsPaid: Number(checkoutSession.metadata.monthsPaid || 0),
                    buyoutPcValue: Number(checkoutSession.metadata.pcValue || 0),
                    buyoutOwnershipRate: Number(checkoutSession.metadata.ownershipRate || 0),

                    status: "bought_out",
                    paymentStatus: "buyout_paid"
                });

                console.log("Buyout completed for order:", checkoutSession.metadata.orderId);
            }
        }
    }

    if (event.type === "invoice.created") {
        await addFinalBuyoutToInvoice(event.data.object);
    }

    if (event.type === "invoice.payment_succeeded" || event.type === "invoice.paid") {
        const invoice = event.data.object;
        const sub = stripeObjectId(
            invoice.subscription ||
            invoice.parent?.subscription_details?.subscription ||
            invoice.lines?.data?.[0]?.parent?.subscription_item_details?.subscription ||
            null
        );

        console.log("Paid invoice subscription:", sub, "invoice:", invoice.id);

        if (!sub || !invoice.id) {
            console.log("No subscription ID on invoice.");
            return res.json({ received: true });
        }

        const snap = await db.collection("orders")
            .where("stripeSubscriptionId", "==", sub)
            .get();

        console.log("Matching orders found:", snap.size);

        for (const docSnap of snap.docs) {
            // Rebuild the count from Stripe instead of incrementing it for each
            // event. Stripe can deliver both event types and retry either one.
            await syncOrderPayments(docSnap.ref, { paidInvoice: invoice });
        }

        if (snap.empty) {
            console.log("No order matched stripeSubscriptionId =", sub);
        }
    }

    if (event.type === "invoice.payment_failed") {
        const invoice = event.data.object;
        const sub = stripeObjectId(
            invoice.subscription ||
            invoice.parent?.subscription_details?.subscription ||
            invoice.lines?.data?.[0]?.parent?.subscription_item_details?.subscription ||
            null
        );

        console.log("invoice.payment_failed subscription:", sub);

        if (!sub) {
            console.log("No subscription ID on failed invoice.");
            return res.json({ received: true });
        }

        const snap = await db.collection("orders")
            .where("stripeSubscriptionId", "==", sub)
            .get();

        for (const docSnap of snap.docs) {
            const order = docSnap.data() || {};
            const missedPaymentDeadlineMs = Date.now() + (30 * 24 * 60 * 60 * 1000);

            await docSnap.ref.update({
                paymentStatus: "missed_payment",
                status: "payment_overdue",
                missedPaymentAt: admin.firestore.FieldValue.serverTimestamp(),
                missedInvoiceId: invoice.id || "",
                missedPaymentDeadlineMs,
                missedPaymentResolved: false,
                returnRequired: false
            });

            try {
                await sendMissedPaymentEmail(order, docSnap.id);
               console.log("EMAIL SENT TO:", order.userEmail);
            } catch (emailErr) {
                console.error("EMAIL ERROR:", emailErr);
            }

            console.log("Missed payment timer started for order:", docSnap.id);
        }

        if (snap.empty) {
            console.log("No order matched failed subscription =", sub);
        }
    }

    if (event.type === "customer.subscription.updated") {
        const subscription = event.data.object;

        if (subscription.cancel_at_period_end === true) {
            const snap = await db.collection("orders")
                .where("stripeSubscriptionId", "==", subscription.id)
                .get();

            for (const docSnap of snap.docs) {
                const order = docSnap.data() || {};
                await docSnap.ref.update({
                    cancelAtPeriodEnd: true,
                    status: order.buyoutPaid === true ? "bought_out"
                      : order.autoFinalInvoicePaid === true && !order.autoBuyoutCancellationRequested
                        ? "payment_overdue" : "cancelling"
                });
            }

            console.log("Subscription set to cancel at period end:", subscription.id);
        }
    }

    if (event.type === "customer.subscription.deleted") {
        const subscription = event.data.object;

        const snap = await db.collection("orders")
            .where("stripeSubscriptionId", "==", subscription.id)
            .get();

        for (const docSnap of snap.docs) {
            const order = docSnap.data();
            const monthsPaid = Number(order.monthsPaid || 0);
            const totalMonths = Number(order.months || 0);

            await docSnap.ref.update({
                cancelAtPeriodEnd: false,
                paymentStatus: order.buyoutPaid === true ? "buyout_paid"
                  : order.autoFinalInvoicePaid && !order.autoBuyoutCancellationRequested ? "missed_payment" : "cancelled",
                status: order.buyoutPaid === true ? "bought_out"
                  : order.autoFinalInvoicePaid && !order.autoBuyoutCancellationRequested ? "payment_overdue"
                  : order.inventoryConflict === true
                    ? "cancelled"
                    : monthsPaid >= totalMonths ? "completed" : "cancelled",
                cancelledAt: admin.firestore.FieldValue.serverTimestamp()
            });
        }

        console.log("Subscription fully ended:", subscription.id);
    }

    res.json({ received: true });

  } catch (err) {
    console.error("WEBHOOK ERROR:", err);
    res.status(400).send("Webhook error");
  }
});

// ================= NORMAL JSON (AFTER WEBHOOK) =================
app.use(express.json());

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error("Missing STRIPE_SECRET_KEY in .env");
}
if (!process.env.STRIPE_WEBHOOK_SECRET) {
  throw new Error("Missing STRIPE_WEBHOOK_SECRET in .env");
}
if (!process.env.FIREBASE_PROJECT_ID) {
  throw new Error("Missing FIREBASE_PROJECT_ID in .env");
}
if (!process.env.FIREBASE_CLIENT_EMAIL) {
  throw new Error("Missing FIREBASE_CLIENT_EMAIL in .env");
}
if (!process.env.FIREBASE_PRIVATE_KEY) {
  throw new Error("Missing FIREBASE_PRIVATE_KEY in .env");
}

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n")
    }),
    storageBucket: `${process.env.FIREBASE_PROJECT_ID}.appspot.com`
  });
}

app.post("/custom-build-deposit", async (req, res) => {
    try {
        const {
            userId,
            fullName,
            email,
            phone,
            gpu,
            cpu,
            motherboard,
            ram,
            cooler,
            case: pcCase,
            psu,
            storage,
            pcpartpickerLink,
            notes
        } = req.body;

        // ✅ REQUIRE LOGIN NOW
        if (!userId) {
            return res.status(401).json({
                error: "You must be logged in."
            });
        }

        if (!fullName || !email || !phone || !gpu || !cpu) {
            return res.status(400).json({
                error: "Missing required fields."
            });
        }

        const session = await stripe.checkout.sessions.create({
            mode: "payment",
            customer_email: email,

            line_items: [
                {
                    price_data: {
                        currency: "usd",
                        product_data: {
                            name: "Custom PC Build Deposit",
                            description: "Refundable after first rental payment."
                        },
                        unit_amount: 10000
                    },
                    quantity: 1
                }
            ],

            metadata: {
                type: "custom_build_deposit",
                userId: String(userId),
                fullName,
                email,
                phone,
                gpu,
                cpu,
                motherboard: motherboard || "",
                ram: ram || "",
                cooler: cooler || "",
                case: pcCase || "",
                psu: psu || "",
                storage: storage || "",
                pcpartpickerLink: pcpartpickerLink || "",
                notes: notes || ""
            },

            success_url: `${process.env.SUCCESS_URL}?type=build_deposit&session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${process.env.CANCEL_URL}`
        });

        res.json({
            url: session.url
        });

    } catch (err) {
        console.error("CUSTOM BUILD DEPOSIT ERROR:", err);
        res.status(500).json({
            error: err.message
        });
    }
});

const db = admin.firestore();

const bucket = admin.storage().bucket();

const mailer = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

async function sendMissedPaymentEmail(order, orderId) {
  if (!order.userEmail) return;

  await mailer.sendMail({
    from: process.env.EMAIL_USER,
    to: order.userEmail,
    bcc: process.env.BUSINESS_EMAIL || "",
    subject: "Missed PC Rental Payment - 30 Day Notice",
    text: `
Hello ${order.fullName || ""},

Your payment for ${order.pcName || "your PC rental"} was missed.

You now have 30 days to either:
1. Pay the missed monthly payment, or
2. Return the PC.

Order ID: ${orderId}

If this is not resolved within 30 days, your order may be cancelled and marked for return.

Thank you.
    `.trim()
  });
}

async function sendCustomBuildOrderEmail(order, orderId) {
    if (!order.userEmail) return;

    await mailer.sendMail({
        from: process.env.EMAIL_USER,
        to: order.userEmail,
        bcc: process.env.BUSINESS_EMAIL || "",
        subject: "Your Custom PC Build Request Was Received",
        text: `
Hello ${order.fullName || ""},

Your custom PC build request has been received and your deposit has been paid.

Order ID: ${orderId}
Deposit paid: $${Number(order.depositAmount || 0).toFixed(2)}

Build details:
CPU: ${order.cpu || "N/A"}
GPU: ${order.gpu || "N/A"}
Motherboard: ${order.motherboard || "N/A"}
RAM: ${order.ram || "N/A"}
Storage: ${order.storage || "N/A"}
Cooler: ${order.cooler || "N/A"}
Case: ${order.case || "N/A"}
PSU: ${order.psu || "N/A"}

PCPartPicker Link:
${order.pcpartpickerLink || "N/A"}

Notes:
${order.notes || "N/A"}

Your order is pending. We will review the build and contact you soon.

Thank you.
        `.trim()
    });
}

async function sendBuyoutReadyEmail(order, orderId) {
  if (!order.userEmail) return;
  if (!order.buyout) return;

  const pcValue = Number(order.pcValue || 0);
  const ownershipRate = Number(order.ownershipRate || 0);
  const monthsPaid = Number(order.monthsPaid || 0);
  const remainingBuyout = getRemainingBuyout(order, monthsPaid);

  if (remainingBuyout <= 0) return;

  await mailer.sendMail({
    from: process.env.EMAIL_USER,
    to: order.userEmail,
    bcc: process.env.BUSINESS_EMAIL || "",
    subject: "Your PC Rental Term Is Complete - Buyout Available",
    text: `
Hello ${order.fullName || ""},

Your rental term for ${order.pcName || "your PC"} is now complete.

You can now buy out the PC and keep it.

Order ID: ${orderId}
Remaining buyout amount: $${remainingBuyout.toFixed(2)}

Log in to your account and open your orders page to complete the buyout.

Thank you.
    `.trim()
  });
}

/* ================= HEALTH CHECK ================= */
app.get("/", (req, res) => {
  res.send("Stripe + Firebase backend running");
});

/* ================= HELPERS ================= */
function stripeObjectId(value) {
  return typeof value === "string" ? value : value?.id || null;
}

function isPaidRentalMonth(invoice) {
  return Boolean(
    invoice?.id &&
    invoice.status === "paid" &&
    ["subscription_create", "subscription_cycle"].includes(invoice.billing_reason) &&
    Number(invoice.total) > 0
  );
}

// Count the initial monthly invoice and each paid renewal once. A separate
// invoice for a plan change, a free trial, or a one-time charge is not a month.
async function getPaidRentalInvoiceIds(subscriptionId) {
  const ids = new Set();
  let startingAfter;

  do {
    const params = { subscription: subscriptionId, status: "paid", limit: 100 };
    if (startingAfter) params.starting_after = startingAfter;
    const page = await stripe.invoices.list(params);
    for (const invoice of page.data) {
      if (isPaidRentalMonth(invoice)) ids.add(invoice.id);
    }
    if (!page.has_more) break;
    if (!page.data.length) throw new Error("Stripe returned an incomplete invoice page");
    startingAfter = page.data[page.data.length - 1].id;
  } while (true);

  return [...ids].sort();
}

// List the original monthly invoices in Stripe billing order, even when an
// earlier month is unpaid. The final scheduled invoice is based on the term,
// not on how many successful-payment webhooks happened to arrive.
async function listScheduledRentalInvoices(subscriptionId) {
  const invoices = [];
  let startingAfter;
  do {
    const params = { subscription: subscriptionId, limit: 100 };
    if (startingAfter) params.starting_after = startingAfter;
    const page = await stripe.invoices.list(params);
    invoices.push(...page.data.filter((item) =>
      ["subscription_create", "subscription_cycle"].includes(item.billing_reason)
    ));
    if (!page.has_more) break;
    if (!page.data.length) throw new Error("Stripe returned an incomplete invoice page");
    startingAfter = page.data[page.data.length - 1].id;
  } while (true);
  return invoices.reverse();
}

async function getFinalBuyoutLines(invoiceId) {
  const lines = [];
  let startingAfter;
  do {
    const params = { limit: 100 };
    if (startingAfter) params.starting_after = startingAfter;
    const page = await stripe.invoices.listLineItems(invoiceId, params);
    for (const line of page.data) {
      let isBuyout = line.metadata?.rtoFinalBuyout === "true";
      const itemId = stripeObjectId(line.invoice_item || line.parent?.invoice_item_details?.invoice_item);
      // Some Stripe API versions expose item metadata on the invoice item
      // rather than the line. Look it up before deciding a line is absent.
      if (!isBuyout && itemId) {
        const item = await stripe.invoiceItems.retrieve(itemId);
        isBuyout = item.metadata?.rtoFinalBuyout === "true";
      }
      if (isBuyout) lines.push(line);
    }
    if (!page.has_more) break;
    if (!page.data.length) throw new Error("Stripe returned incomplete invoice lines");
    startingAfter = page.data[page.data.length - 1].id;
  } while (true);
  return lines;
}

function getAutoFinalTerms(subscription) {
  const meta = subscription.metadata || {};
  if (meta.autoFinalBuyout !== "true" || meta.buyout !== "true") return null;
  const months = Number(meta.months);
  const cents = Number(meta.finalBuyoutCents);
  if (!Number.isInteger(months) || months < 3 || months > 24 ||
      !Number.isSafeInteger(cents) || cents < 0 || !meta.userId || !/^[0-9]+$/.test(meta.finalBuyoutCents || "")) {
    throw new Error("Invalid automatic buyout terms on subscription");
  }
  return { months, cents };
}

// Runs on invoice.created before Stripe finalizes and charges the invoice.
// Only new agreements with an explicit final-payment acceptance are eligible.
async function addFinalBuyoutToInvoice(eventInvoice) {
  if (eventInvoice.billing_reason !== "subscription_cycle" || !eventInvoice.id) return;
  const subscriptionId = stripeObjectId(eventInvoice.subscription ||
    eventInvoice.parent?.subscription_details?.subscription ||
    eventInvoice.lines?.data?.[0]?.parent?.subscription_item_details?.subscription);
  if (!subscriptionId) return;
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const terms = getAutoFinalTerms(subscription);
  if (!terms || ["canceled", "incomplete_expired"].includes(subscription.status) || subscription.cancel_at_period_end) return;
  const scheduled = await listScheduledRentalInvoices(subscriptionId);
  const index = scheduled.findIndex((item) => item.id === eventInvoice.id);
  if (index < 0) throw new Error("New invoice not found in subscription invoice history");
  if (index !== terms.months - 1) return;

  const matches = await db.collection("orders").where("stripeSubscriptionId", "==", subscriptionId).get();
  if (matches.size !== 1) throw new Error("Final buyout requires exactly one matching rental order");
  const orderRef = matches.docs[0].ref;
  // Serialize final-invoice preparation against early cancellation. If the
  // invoice is already being processed, cancellation requires support review.
  const claimed = await db.runTransaction(async (tx) => {
    const snap = await tx.get(orderRef);
    if (!snap.exists) throw new Error("Rental order disappeared");
    const order = snap.data() || {};
    if (order.stripeSubscriptionId !== subscriptionId || order.userId !== subscription.metadata.userId ||
        order.autoFinalBuyout !== true || Math.round(Number(order.finalBuyoutAmount) * 100) !== terms.cents ||
        Number(order.months) !== terms.months) throw new Error("Automatic buyout does not match the rental order");
    if (order.inventoryConflict || order.autoBuyoutCancellationRequested || order.buyoutPaid ||
        ["cancelled", "cancelling", "bought_out"].includes(String(order.status || "").toLowerCase())) return false;
    if (order.autoFinalInvoiceId && order.autoFinalInvoiceId !== eventInvoice.id) throw new Error("Another final invoice is already recorded");
    tx.update(orderRef, { autoFinalInvoiceId: eventInvoice.id, autoFinalInvoiceState: "preparing" });
    return true;
  });
  if (!claimed) return;

  const existing = await getFinalBuyoutLines(eventInvoice.id);
  if (existing.length > 1 || (existing.length === 1 && Number(existing[0].amount) !== terms.cents)) {
    throw new Error("Final invoice has a duplicate or incorrect buyout line");
  }
  if (terms.cents > 0 && existing.length === 0) {
    const invoice = await stripe.invoices.retrieve(eventInvoice.id);
    if (invoice.status !== "draft") throw new Error("Final invoice was finalized without its buyout; manual review required");
    const customer = stripeObjectId(invoice.customer);
    if (!customer) throw new Error("Final invoice has no customer");
    await stripe.invoiceItems.create({
      customer,
      invoice: invoice.id,
      currency: "usd",
      amount: terms.cents,
      discountable: false,
      description: "Final rent-to-own buyout balance",
      metadata: { rtoFinalBuyout: "true", subscriptionId }
    }, { idempotencyKey: `rto-final-buyout-${invoice.id}` });
  }
  await orderRef.update({ autoFinalInvoiceState: "attached" });
}

// Do not transfer ownership unless the last scheduled invoice is actually
// paid and contains the exact authorized buyout line (or the balance was $0).
async function getPaidFinalBuyout(order, subscription, paidInvoiceIds) {
  const terms = getAutoFinalTerms(subscription);
  if (!terms || order.autoFinalBuyout !== true ||
      Math.round(Number(order.finalBuyoutAmount) * 100) !== terms.cents ||
      Number(order.months) !== terms.months) return null;
  const scheduled = await listScheduledRentalInvoices(subscription.id);
  const invoice = scheduled[terms.months - 1];
  if (!invoice || !paidInvoiceIds.includes(invoice.id)) return null;
  const lines = await getFinalBuyoutLines(invoice.id);
  if (terms.cents === 0 ? lines.length !== 0 :
      lines.length !== 1 || Number(lines[0].amount) !== terms.cents) return null;
  return { invoiceId: invoice.id, amount: terms.cents / 100,
    allMonthsPaid: paidInvoiceIds.length >= terms.months };
}

// Only refund payments associated with this rental's paid invoices. The
// invoice payment API is used by recent Stripe versions; older versions
// expose the payment intent or charge directly on the invoice.
async function getRentalInvoiceCharges(subscriptionId) {
  const invoiceIds = await getPaidRentalInvoiceIds(subscriptionId);
  const invoices = [];

  for (const invoiceId of invoiceIds) {
    let payments = [];
    if (stripe.invoicePayments && typeof stripe.invoicePayments.list === "function") {
      let startingAfter;
      do {
        const params = { invoice: invoiceId, status: "paid", limit: 100 };
        if (startingAfter) params.starting_after = startingAfter;
        const page = await stripe.invoicePayments.list(params);
        payments.push(...page.data.map((item) => ({
          paymentIntent: stripeObjectId(item.payment?.payment_intent),
          charge: stripeObjectId(item.payment?.charge),
          amount: Number(item.amount_paid || 0)
        })));
        if (!page.has_more) break;
        if (!page.data.length) throw new Error("Stripe returned an incomplete invoice payment page");
        startingAfter = page.data[page.data.length - 1].id;
      } while (true);
    } else {
      const invoice = await stripe.invoices.retrieve(invoiceId);
      payments = [{
        paymentIntent: stripeObjectId(invoice.payment_intent),
        charge: stripeObjectId(invoice.charge),
        amount: Number(invoice.amount_paid || 0)
      }];
    }

    const charges = [];
    for (const payment of payments) {
      let charge;
      if (payment.charge) {
        charge = await stripe.charges.retrieve(payment.charge);
      } else if (payment.paymentIntent) {
        const intent = await stripe.paymentIntents.retrieve(payment.paymentIntent, { expand: ["latest_charge"] });
        charge = typeof intent.latest_charge === "object"
          ? intent.latest_charge
          : intent.latest_charge ? await stripe.charges.retrieve(intent.latest_charge) : null;
      }
      if (charge?.id && charge.status === "succeeded" && payment.amount > 0) {
        charges.push({ charge, allocation: payment.amount });
      }
    }
    invoices.push({ invoiceId, charges });
  }
  return invoices;
}

async function getOrderRefundsForCharge(chargeId, orderId, reason = "rent_to_own_extra_cancel_refund") {
  const refunds = [];
  let startingAfter;
  do {
    const params = { charge: chargeId, limit: 100 };
    if (startingAfter) params.starting_after = startingAfter;
    const page = await stripe.refunds.list(params);
    refunds.push(...page.data.filter((refund) =>
      refund.metadata?.orderId === orderId &&
      refund.metadata?.reason === reason &&
      refund.status !== "failed" && refund.status !== "canceled"
    ));
    if (!page.has_more) break;
    if (!page.data.length) throw new Error("Stripe returned an incomplete refund page");
    startingAfter = page.data[page.data.length - 1].id;
  } while (true);
  return refunds;
}

async function completePaidRental(orderRef, subscriptionId) {
  const orderSnap = await orderRef.get();
  if (!orderSnap.exists) return;
  const order = orderSnap.data() || {};
  const totalMonths = Number(order.months || 0);
  if (order.inventoryConflict === true || order.stripeSubscriptionId !== subscriptionId || totalMonths <= 0 ||
      Number(order.monthsPaid || 0) < totalMonths) return;

  // Preserve the existing business rule: stop charging once all agreed
  // monthly payments have been collected.
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  if (subscription.status !== "canceled") {
    try {
      await stripe.subscriptions.cancel(subscriptionId);
    } catch (err) {
      // A simultaneous webhook or refresh may already have canceled it.
      const latest = await stripe.subscriptions.retrieve(subscriptionId);
      if (latest.status !== "canceled") throw err;
    }
  }

  const notificationOrder = await db.runTransaction(async (tx) => {
    const currentSnap = await tx.get(orderRef);
    if (!currentSnap.exists) return null;
    const current = currentSnap.data() || {};
    const required = Number(current.months || 0);
    if (current.inventoryConflict === true || current.stripeSubscriptionId !== subscriptionId || required <= 0 ||
        Number(current.monthsPaid || 0) < required) return null;

    const update = { cancelAtPeriodEnd: false };
    if (current.status !== "bought_out") update.status = "completed";
    if (!current.cancelledAt) update.cancelledAt = admin.firestore.FieldValue.serverTimestamp();

    const notify = current.buyout === true && current.autoFinalBuyout !== true && current.buyoutPaid !== true && current.buyoutEmailSent !== true &&
      Boolean(current.userEmail) &&
      getRemainingBuyout(current) > 0;
    if (notify) {
      // Claim this notification transactionally so concurrent webhook deliveries
      // don't send the same buyout email multiple times.
      update.buyoutEmailSent = true;
      update.buyoutEmailSentAt = admin.firestore.FieldValue.serverTimestamp();
    }
    tx.update(orderRef, update);
    return notify ? current : null;
  });

  if (notificationOrder) {
    try {
      await sendBuyoutReadyEmail(notificationOrder, orderRef.id);
    } catch (err) {
      console.error("BUYOUT EMAIL ERROR:", err);
    }
  }
}

// Reconcile with Stripe even when a webhook was missed or counted twice.
// A revision check forces overlapping syncs to reload rather than allowing an
// older invoice snapshot to overwrite a newer one.
async function syncOrderPayments(orderRef, { paidInvoice } = {}) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const startSnap = await orderRef.get();
    if (!startSnap.exists) throw new Error("Order not found");
    const start = startSnap.data() || {};
    const subscriptionId = start.stripeSubscriptionId;
    if (!subscriptionId || typeof subscriptionId !== "string") {
      throw new Error("This order has no Stripe subscription ID");
    }

    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    if (!start.userId || subscription.metadata?.userId !== start.userId) {
      throw new Error("Stripe subscription does not match the order owner");
    }
    const invoiceIds = await getPaidRentalInvoiceIds(subscriptionId);
    const finalBuyout = await getPaidFinalBuyout(start, subscription, invoiceIds);
    const revision = Number(start.stripePaymentSyncRevision || 0);

    const result = await db.runTransaction(async (tx) => {
      const currentSnap = await tx.get(orderRef);
      if (!currentSnap.exists) throw new Error("Order not found");
      const current = currentSnap.data() || {};
      if (current.stripeSubscriptionId !== subscriptionId || current.userId !== start.userId ||
          Number(current.stripePaymentSyncRevision || 0) !== revision) {
        return { retry: true };
      }

      const monthsPaid = invoiceIds.length;
      const totalMonths = Math.max(0, Number(current.months || 0));
      const update = {
        monthsPaid,
        monthsLeft: Math.max(totalMonths - monthsPaid, 0),
        paidInvoiceIds: invoiceIds,
        stripePaymentSyncRevision: revision + 1,
        stripePaymentsSyncedAt: admin.firestore.FieldValue.serverTimestamp()
      };
      if (current.buyout) {
        update.remainingBuyout = getRemainingBuyout(current, monthsPaid).toFixed(2);
      }

      const resolvingMissedInvoice = current.missedInvoiceId
        ? invoiceIds.includes(current.missedInvoiceId)
        : paidInvoice && isPaidRentalMonth(paidInvoice) && invoiceIds.includes(paidInvoice.id);
      if (resolvingMissedInvoice &&
          (current.paymentStatus === "missed_payment" || current.status === "payment_overdue")) {
        update.paymentStatus = "paid";
        update.missedPaymentResolved = true;
        update.missedPaymentDeadlineMs = admin.firestore.FieldValue.delete();
        update.missedInvoiceId = admin.firestore.FieldValue.delete();
        update.returnRequired = false;
        if (current.status === "payment_overdue") update.status = "active";
      }

      if (finalBuyout && current.autoFinalBuyout === true && !current.autoBuyoutCancellationRequested &&
          current.inventoryConflict !== true && !["cancelled", "cancelling"].includes(String(current.status || "").toLowerCase())) {
        update.autoFinalInvoicePaid = true;
        update.buyoutInvoiceId = finalBuyout.invoiceId;
        if (finalBuyout.allMonthsPaid) {
          update.buyoutPaid = true;
          update.buyoutPaidAt = admin.firestore.FieldValue.serverTimestamp();
          update.buyoutAmountPaid = finalBuyout.amount;
          update.remainingBuyout = "0.00";
          update.paymentStatus = "buyout_paid";
          update.status = "bought_out";
        } else {
          // The final invoice was paid, but an earlier monthly invoice is still
          // unpaid. Do not grant ownership or allow another monthly renewal.
          update.paymentStatus = "missed_payment";
          update.status = "payment_overdue";
        }
      }
      tx.update(orderRef, update);
      return { monthsPaid, monthsLeft: update.monthsLeft, subscriptionId };
    });

    if (result.retry) continue;
    if (finalBuyout && !finalBuyout.allMonthsPaid && !start.autoBuyoutCancellationRequested &&
        !subscription.cancel_at_period_end && !["canceled", "incomplete_expired"].includes(subscription.status)) {
      await stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: true });
    }
    await completePaidRental(orderRef, subscriptionId);
    return result;
  }
  throw new Error("Payment synchronization was busy; please retry");
}

function toMoneyNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function clampMonths(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 1;
  if (num < 1) return 1;
  if (num > 24) return 24;
  return Math.floor(num);
}

function getRemainingBuyout(order, monthsPaid = Number(order.monthsPaid || 0)) {
  const credit = Math.max(
    Number(order.ownershipRate || 0) * monthsPaid - Number(order.ownershipCreditRefunded || 0),
    0
  );
  return Math.max(Number(order.pcValue || 0) - credit, 0);
}

function buildPricing({ baseRent, pcValue, months, buyout, ownershipExtra }) {

  // Split the full rent-to-own price; ordinary rent uses the same rent portion.
  const includedOwnership = Math.floor((baseRent * 0.40) / 5) * 5;
  const ownershipRate = buyout
    ? Math.max(includedOwnership, Number(ownershipExtra || 0))
    : 0;

  const rentPerMonth = baseRent - includedOwnership;
  const totalPerMonth = rentPerMonth + ownershipRate;

  const totalOwnership = ownershipRate * months;

  const remainingBuyout = buyout
    ? Math.max(pcValue - totalOwnership, 0)
    : pcValue;

  return {
    rentPerMonth,
    ownershipRate,
    totalOwnership,
    remainingBuyout,
    totalPerMonth
  };
}

async function getPcOrThrow(pcId) {
  const pcRef = db.collection("pcs").doc(pcId);
  const pcSnap = await pcRef.get();

  if (!pcSnap.exists) {
    const err = new Error("PC not found");
    err.statusCode = 404;
    throw err;
  }

  const pc = pcSnap.data() || {};
  const displayValue =
    pc.hasDiscount && Number(pc.discountPrice) > 0
      ? toMoneyNumber(pc.discountPrice)
      : toMoneyNumber(pc.pcValue);

  const pcValue = displayValue;
  const baseRent = Math.ceil((displayValue / 12) / 5) * 5;

  if (pcValue < 0) {
    const err = new Error("Invalid PC pcValue in Firestore");
    err.statusCode = 400;
    throw err;
  }

  const displayName =
    pc.name ||
    [pc.cpu, pc.gpu].filter(Boolean).join(" / ") ||
    `PC Rental ${pcId}`;

  return {
    pc,
    baseRent,
    pcValue,
    displayName
  };
}

/* ================= CREATE MONTHLY SUBSCRIPTION ================= */
app.post("/checkout", async (req, res) => {
  try {
    const {
    pcId,
    originalCustomBuildOrderId,
    userId,
    userEmail,
    fullName,
    addressLine1,
    addressLine2,
    city,
    state,
    postalCode,
    country,
    pcName,
    image,
    cpu,
    gpu,
    ram,
    storage,
    months,
    monthsPaid,
    buyout,
    ownershipExtra,
    ageConfirmed,
    finalBuyoutAccepted,
    remainingBuyout: quotedRemainingBuyout,
    totalPerMonth: quotedTotalPerMonth,
      } = req.body;

    if (ageConfirmed !== true) {
      return res.status(403).json({
        error: "You must be 18 years or older to rent."
      });
    }

    const isCustomBuild = !!originalCustomBuildOrderId;

    if (!isCustomBuild && (!pcId || typeof pcId !== "string")) {
      return res.status(400).json({ error: "Missing or invalid pcId" });
    }

    if (!userId || typeof userId !== "string") {
      return res.status(400).json({ error: "Missing or invalid userId" });
    }

        let pc = {};
    let baseRent = 0;
    let pcValue = 0;
    let displayName = "";

    if (originalCustomBuildOrderId) {
      const orderRef = db.collection("orders").doc(originalCustomBuildOrderId);
      const orderSnap = await orderRef.get();

      if (!orderSnap.exists) {
        return res.status(404).json({ error: "Custom build order not found" });
      }

      const orderData = orderSnap.data() || {};

      pc = orderData;
      pcValue = Number(orderData.pcValue || 0);
      baseRent = Number(orderData.baseRent) > 0
        ? Number(orderData.baseRent)
        : Math.ceil((pcValue / 12) / 5) * 5;
      displayName = orderData.pcName || "Custom PC Rental";
    } else {
      const result = await getPcOrThrow(pcId);
      pc = result.pc;
      baseRent = result.baseRent;
      pcValue = result.pcValue;
      displayName = result.displayName;
    }

    const safeMonths = clampMonths(months);
    const safeBuyout = Boolean(buyout);
      
    console.log("OWNERSHIP DEBUG BEFORE PRICING:", {
        buyout,
        safeBuyout,
        ownershipExtra,
        type: typeof ownershipExtra
    });

    const {
        rentPerMonth,
        ownershipRate,
        totalOwnership,
        remainingBuyout,
        totalPerMonth
    } = buildPricing({
        baseRent,
        pcValue,
        months: safeMonths,
        buyout: safeBuyout,
        ownershipExtra: Number(ownershipExtra || 0)
    });

    console.log("OWNERSHIP DEBUG AFTER PRICING:", {
        ownershipRate,
        totalOwnership,
        remainingBuyout,
        totalPerMonth
    });

    if (!Number.isFinite(totalPerMonth) || totalPerMonth <= 0 || !Number.isFinite(pcValue) || pcValue <= 0) {
      return res.status(400).json({ error: "Calculated monthly total or PC value is invalid" });
    }
    if (safeBuyout && safeMonths < 3) {
      return res.status(400).json({ error: "Minimum term for rent-to-own is 3 months." });
    }
    if (!Number.isFinite(ownershipRate) || (safeBuyout && totalOwnership > pcValue)) {
      return res.status(400).json({ error: "Ownership payments exceed the PC value." });
    }
    if (safeBuyout && (finalBuyoutAccepted !== true ||
        !Number.isFinite(Number(quotedRemainingBuyout)) || !Number.isFinite(Number(quotedTotalPerMonth)) ||
        Math.round(Number(quotedRemainingBuyout) * 100) !== Math.round(remainingBuyout * 100) ||
        Math.round(Number(quotedTotalPerMonth) * 100) !== Math.round(totalPerMonth * 100))) {
      return res.status(400).json({ error: "Please reload the rental page and review the final payment amount before checkout." });
    }

    let pcRef = null;

    if (!isCustomBuild) {
      pcRef = db.collection("pcs").doc(pcId);

      const pcSnap = await pcRef.get();

      if (!pcSnap.exists) {
        return res.status(404).json({ error: "PC not found" });
      }

      if (pcSnap.data()?.available !== true) {
        return res.status(409).json({ error: "This PC is no longer available to rent." });
      }
    }

    const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        payment_method_types: ["card"],

        line_items: [
            {
                price_data: {
                    currency: "usd",
                    product_data: {
                        name: displayName,
                        description: [
                            `PC ID: ${pcId}`,
                            `Rent portion: $${rentPerMonth.toFixed(2)}/mo`,
                            `Buyout: ${safeBuyout ? "Enabled" : "Disabled"}`,
                            `Months Selected: ${safeMonths}`,
                            `Ownership Credit: $${ownershipRate.toFixed(2)}/mo`,
                            safeBuyout ? `Final month total: $${(totalPerMonth + remainingBuyout).toFixed(2)} (includes $${remainingBuyout.toFixed(2)} buyout)` : "No buyout"
                        ].join(" | "),
                        images: pc.image ? [pc.image] : []
                    },
                    unit_amount: Math.round(totalPerMonth * 100),
                    recurring: {
                        interval: "month"
                    }
                },
                quantity: 1
            }
        ],

        subscription_data: {
                metadata: {
                        type: "subscription",
                        userId: String(userId),

                        // 🔥 LEGAL / AUDIT LOGGING
                        agreedToTerms: "true",
                        signature: String(fullName || ""),
                        signatureIp: String(req.headers["x-forwarded-for"] || req.ip || ""),
                        userAgent: String(req.headers["user-agent"] || ""),
                        userEmail: String(userEmail || ""),
                        fullName: String(fullName || ""),
                        addressLine1: String(addressLine1 || ""),
                        addressLine2: String(addressLine2 || ""),
                        city: String(city || ""),
                        state: String(state || ""),
                        postalCode: String(postalCode || ""),
                        country: String(country || ""),
                        originalCustomBuildOrderId: String(originalCustomBuildOrderId || ""),
                        pcId: String(pcId || ""),
                        pcName: String(pcName || pc.name || displayName || "PC Rental"),
                        image: String(image || pc.image || ""),
                        cpu: String(cpu || pc.cpu || "N/A"),
                        gpu: String(gpu || pc.gpu || "N/A"),
                        ram: String(ram || pc.ram || "N/A"),
                        storage: String(storage || pc.storage || "N/A"),
                        pcValue: pcValue.toFixed(2),
                        months: String(safeMonths),
                        monthsPaid: "0",
                        buyout: String(safeBuyout),
                        ownershipRate: ownershipRate.toFixed(2),
                        remainingBuyout: remainingBuyout.toFixed(2),
                        autoFinalBuyout: String(safeBuyout),
                        finalBuyoutCents: String(safeBuyout ? Math.round(remainingBuyout * 100) : 0),
                        termsVersion: "final-buyout-v1",
                        rentPerMonth: rentPerMonth.toFixed(2),
                        baseRent: baseRent.toFixed(2),
                        standardRent: rentPerMonth.toFixed(2),
                        totalPerMonth: totalPerMonth.toFixed(2)
                }
        },

        success_url: (process.env.SUCCESS_URL || "http://localhost:3000/success.html") + "?session_id={CHECKOUT_SESSION_ID}",
        cancel_url: process.env.CANCEL_URL || "http://localhost:3000/cancel.html"
    });

    if (!session.url) {
      return res.status(500).json({ error: "No session URL returned from Stripe" });
    }

    res.json({
      url: session.url,
      pricing: {
        pcId,
        displayName,
        baseRent,
        pcValue,
        months: safeMonths,
        buyout: safeBuyout,
        rentPerMonth,
        ownershipRate,
        totalOwnership,
        remainingBuyout,
        totalPerMonth
      }
    });
  } catch (err) {
    console.error("CHECKOUT ERROR:", err);
    res.status(err.statusCode || 500).json({
      error: err.message || "Stripe subscription creation failed"
    });
  }
});

/* ================= SYNC AN EXISTING RENTAL WITH STRIPE ================= */
app.post("/sync-order-payments", async (req, res) => {
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing auth token" });
  }

  let decodedToken;
  try {
    decodedToken = await admin.auth().verifyIdToken(authHeader.slice(7));
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired auth token" });
  }

  try {
    const { orderId } = req.body || {};
    if (!orderId || typeof orderId !== "string" || orderId.includes("/")) {
      return res.status(400).json({ error: "Missing or invalid orderId" });
    }
    const orderRef = db.collection("orders").doc(orderId);
    const orderSnap = await orderRef.get();
    if (!orderSnap.exists) return res.status(404).json({ error: "Order not found" });

    const order = orderSnap.data() || {};
    const isAdmin = decodedToken.email === "noahlarson2009@gmail.com";
    if (order.userId !== decodedToken.uid && !isAdmin) {
      return res.status(403).json({ error: "Not your order" });
    }
    if (!order.stripeSubscriptionId) {
      return res.status(400).json({ error: "This order has no Stripe subscription" });
    }

    const result = await syncOrderPayments(orderRef);
    res.json({ success: true, monthsPaid: result.monthsPaid, monthsLeft: result.monthsLeft });
  } catch (err) {
    console.error("STRIPE PAYMENT SYNC ERROR:", err);
    res.status(500).json({ error: "Unable to sync this order with Stripe. Please try again." });
  }
});

/* ================= VERIFY STRIPE SESSION ================= */
app.post("/verify-session", async (req, res) => {
  try {
    const authHeader = req.headers.authorization || "";

    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Missing auth token" });
    }

    const idToken = authHeader.split("Bearer ")[1];
    const decodedToken = await admin.auth().verifyIdToken(idToken);

    const { sessionId } = req.body;

    if (!sessionId || typeof sessionId !== "string") {
      return res.status(400).json({ error: "Missing sessionId" });
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["subscription"]
    });

    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    if (session.payment_status !== "paid" || session.status !== "complete") {
      return res.status(400).json({
        error: "Payment not completed",
        paid: false
      });
    }

    const metadata = session.subscription?.metadata;

    if (!metadata) {
      return res.status(400).json({
        error: "Missing metadata on subscription"
      });
    }

    if (metadata.userId !== decodedToken.uid) {
      return res.status(403).json({
        error: "This session does not belong to you"
      });
    }

    const subscriptionId = typeof session.subscription === "object"
      ? session.subscription.id
      : session.subscription;

    const months = Number(metadata.months);

    const remainingBuyout = Math.max(
      Number(metadata.pcValue || 0) -
      (Number(metadata.ownershipRate || 0) * 1),
      0
    );

    const order = {
      userId: metadata.userId || "",
      userEmail: metadata.userEmail || "",
      fullName: metadata.fullName || "",
      contractAccepted: true,
      signature: metadata.signature || metadata.fullName || "",
      agreedToTerms: metadata.agreedToTerms === "true",
      signatureEmail: metadata.userEmail || "",
      signatureIp: metadata.signatureIp || "",
      userAgent: metadata.userAgent || "",
      signedAt: admin.firestore.FieldValue.serverTimestamp(),
      addressLine1: metadata.addressLine1 || "",
      addressLine2: metadata.addressLine2 || "",
      city: metadata.city || "",
      state: metadata.state || "",
      postalCode: metadata.postalCode || "",
      country: metadata.country || "",
      pcId: metadata.pcId || "",
      pcName: metadata.pcName || "",
      image: metadata.image || "",
      cpu: metadata.cpu || "",
      gpu: metadata.gpu || "",
      ram: metadata.ram || "",
      storage: metadata.storage || "",
      pcValue: Number(metadata.pcValue || 0),
      months,
      monthsPaid: 1,
      monthsLeft: Math.max(months - 1, 0),
      paidInvoiceIds: [],
      buyout: metadata.buyout === "true",
      autoFinalBuyout: metadata.autoFinalBuyout === "true",
      finalBuyoutAmount: Number(metadata.finalBuyoutCents || 0) / 100,
      termsVersion: metadata.termsVersion || "",
      multiplier: Number(metadata.multiplier || 1),
      ownershipRate: Number(metadata.ownershipRate || 0),
      remainingBuyout: remainingBuyout.toFixed(2),
      rentPerMonth: Number(metadata.rentPerMonth || 0),
      ...(Number(metadata.baseRent) > 0 ? { baseRent: Number(metadata.baseRent) } : {}),
      ...(metadata.standardRent != null && Number.isFinite(Number(metadata.standardRent))
        ? { standardRent: Number(metadata.standardRent) } : {}),
      totalPerMonth: Number(metadata.totalPerMonth || 0),
      paymentStatus: "paid",
      status: "pending",
      stripeSubscriptionId: subscriptionId || "",
      cancelledAt: null
    };

    const orderRef = db.collection("orders").doc(sessionId);
    const paymentRef = db.collection("payments").doc(sessionId);

    let pcRef = null;

    const isCustomBuild = !!metadata.originalCustomBuildOrderId;

    if (!isCustomBuild && order.pcId) {
      pcRef = db.collection("pcs").doc(order.pcId);
    }

    await db.runTransaction(async (tx) => {
      const existingOrder = await tx.get(orderRef);
      const existing = existingOrder.exists ? (existingOrder.data() || {}) : null;

      // A prior visit must not make a PC unavailable again after the admin
      // deliberately relisted it. Older active orders get one repair attempt.
      const canRepairOldOrder = existing && !existing.listingAvailabilityFinalized &&
        ["pending", "active", "payment_overdue", "cancelling"].includes(
          String(existing.status || "pending").toLowerCase()
        );
      const shouldClaimListing = Boolean(pcRef && (!existing || canRepairOldOrder));
      const pcSnap = shouldClaimListing ? await tx.get(pcRef) : null;
      let inventoryConflict = existing?.inventoryConflict === true;
      let inventoryConflictReason = existing?.inventoryConflictReason || "";

      if (shouldClaimListing) {
        if (!pcSnap.exists) {
          // An older order may have been fulfilled before its listing was
          // deleted. Only a newly finalized payment is a new conflict.
          if (!existing) {
            inventoryConflict = true;
            inventoryConflictReason = "listing_missing";
          }
        } else {
          const listing = pcSnap.data() || {};
          const alreadyClaimedForOrder = existing && listing.rented === true &&
            listing.rentedBy === order.userId;

          if (listing.available === true) {
            tx.update(pcRef, {
              available: false,
              rented: true,
              rentedBy: order.userId,
              rentedAt: admin.firestore.FieldValue.serverTimestamp()
            });
          } else if (!alreadyClaimedForOrder) {
            // A second customer may already have paid while both checkouts
            // were open. Keep their paid order, but never reassign this PC.
            // For legacy orders the current listing may have been deliberately
            // relisted, so don't cancel an older customer's subscription.
            if (!existing) {
              inventoryConflict = true;
              inventoryConflictReason = "listing_unavailable";
            }
          }
        }
      }

      if (existing) {
        if (shouldClaimListing) {
          tx.update(orderRef, {
            listingAvailabilityFinalized: true,
            inventoryConflict,
            inventoryConflictReason
          });
        }
        return;
      }

      tx.set(orderRef, {
        ...order,
        stripeSessionId: sessionId,
        status: order.status || "pending",
        paymentStatus: order.paymentStatus || "paid",
        listingAvailabilityFinalized: true,
        inventoryConflict,
        inventoryConflictReason,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

      tx.set(paymentRef, {
        finalized: true,
        stripeSessionId: sessionId,
        userId: order.userId,
        pcId: order.pcId,
        finalizedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    // If two people paid from already-open checkout sessions, stop future
    // renewals for the second order while the business resolves the payment.
    const finalizedOrder = await orderRef.get();
    if (finalizedOrder.data()?.inventoryConflict && subscriptionId) {
      const conflictSubscription = await stripe.subscriptions.retrieve(subscriptionId);
      if (!["canceled", "incomplete_expired"].includes(conflictSubscription.status) &&
          !conflictSubscription.cancel_at_period_end) {
        await stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: true });
      }
    }

    // The first invoice webhook can arrive before the order exists. Reconcile
    // after saving the order so that initial payment is counted exactly once.
    await syncOrderPayments(orderRef);

    if (metadata.originalCustomBuildOrderId) {
      const customOrderRef = db.collection("orders").doc(metadata.originalCustomBuildOrderId);
      const customOrderSnap = await customOrderRef.get();

      if (customOrderSnap.exists) {
        const customOrder = customOrderSnap.data() || {};

        if (
          customOrder.depositRefunded !== true &&
          customOrder.depositChargeId
        ) {
          const refund = await stripe.refunds.create({
            charge: customOrder.depositChargeId,
            amount: 10000,
            metadata: {
              orderId: metadata.originalCustomBuildOrderId,
              rentalSessionId: sessionId,
              reason: "custom_build_first_month_paid"
            }
          });

          await customOrderRef.update({
            depositRefunded: true,
            depositRefundAmount: 100,
            depositRefundId: refund.id,
            depositRefundedAt: admin.firestore.FieldValue.serverTimestamp(),

            rentalStarted: true,
            readyForRent: false,
            rentalSessionId: sessionId,
            rentalStartedAt: admin.firestore.FieldValue.serverTimestamp()
          });

          console.log("CUSTOM BUILD DEPOSIT REFUNDED:", metadata.originalCustomBuildOrderId);
        }
      }
    }

    const savedOrder = await orderRef.get();
    res.json({
      paid: true,
      inventoryConflict: savedOrder.data()?.inventoryConflict === true,
      order: savedOrder.data()
    });

  } catch (err) {
    console.error("VERIFY SESSION ERROR:", err);
    res.status(500).json({
      error: err.message || "Failed to verify session"
    });
  }
});

/* ================= BUYOUT QUOTE ================= */
app.post("/buyout-quote", async (req, res) => {
  try {
    const { pcId, monthsPaid, ownershipExtra } = req.body;

    if (!pcId || typeof pcId !== "string") {
      return res.status(400).json({ error: "Missing or invalid pcId" });
    }

    const safeMonthsPaid = clampMonths(monthsPaid);

    const { baseRent, pcValue, displayName } = await getPcOrThrow(pcId);

    const safeOwnershipExtra = Number(ownershipExtra || 0);

    const pricing = buildPricing({
        baseRent,
        pcValue,
        months: safeMonthsPaid,
        buyout: true,
        ownershipExtra: safeOwnershipExtra
    });

    res.json({
      pcId,
      displayName,
      monthsPaid: safeMonthsPaid,
      ownershipRate: pricing.ownershipRate,
      totalOwnership: pricing.totalOwnership,
      remainingBuyout: pricing.remainingBuyout
    });
  } catch (err) {
    console.error("BUYOUT QUOTE ERROR:", err);
    res.status(err.statusCode || 500).json({
      error: err.message || "Failed to calculate buyout quote"
    });
  }
});

/* ================= CREATE ONE-TIME BUYOUT PAYMENT ================= */
app.post("/buyout", async (req, res) => {
  try {
    const authHeader = req.headers.authorization || "";

    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Missing auth token" });
    }

    const idToken = authHeader.split("Bearer ")[1];
    const decodedToken = await admin.auth().verifyIdToken(idToken);

    const { orderId } = req.body;

    if (!orderId || typeof orderId !== "string") {
      return res.status(400).json({ error: "Missing or invalid orderId" });
    }

    const orderRef = db.collection("orders").doc(orderId);
    const orderSnap = await orderRef.get();

    if (!orderSnap.exists) {
      return res.status(404).json({ error: "Order not found" });
    }

    let order = orderSnap.data() || {};

    const isAdmin = decodedToken.email === "noahlarson2009@gmail.com";
    if (order.userId !== decodedToken.uid && !isAdmin) {
      return res.status(403).json({ error: "Not your order" });
    }

    if (!order.buyout) {
      return res.status(400).json({ error: "Buyout is not enabled for this order" });
    }

    // Don't calculate eligibility or ownership credit from stale order data.
    await syncOrderPayments(orderRef);
    order = (await orderRef.get()).data() || {};
    const status = String(order.status || "").toLowerCase();
    const monthsPaid = Number(order.monthsPaid || 0);

    if (order.inventoryConflict === true) {
      return res.status(400).json({ error: "This order needs an inventory issue resolved before buyout." });
    }

    if (order.buyoutPaid === true || status === "bought_out") {
      return res.status(400).json({ error: "This order has already been bought out" });
    }

    if (order.autoFinalBuyout === true && status !== "cancelled") {
      return res.status(400).json({ error: "This agreement's buyout is included in the final monthly payment. If your completed payment needs review, please contact Rent a Rig." });
    }

    if (monthsPaid < 3) {
      return res.status(400).json({
        error: "Buyout unlocks after 3 months of payments."
      });
    }

    let cancelledAtMs = 0;

    if (order.cancelledAt && typeof order.cancelledAt.toMillis === "function") {
      cancelledAtMs = order.cancelledAt.toMillis();
    } else if (order.cancelledAt && typeof order.cancelledAt.seconds === "number") {
      cancelledAtMs = order.cancelledAt.seconds * 1000;
    } else if (typeof order.cancelledAt === "number") {
      cancelledAtMs = order.cancelledAt;
    }

    if (cancelledAtMs > 0) {
      const deadlineMs = cancelledAtMs + (60 * 24 * 60 * 60 * 1000);

      if (Date.now() > deadlineMs) {
        return res.status(400).json({ error: "The 60-day buyout window has expired" });
      }
    }

    const pcValue = Number(order.pcValue || 0);
    const ownershipRate = Number(order.ownershipRate || 0);

    const remainingBuyout = getRemainingBuyout(order, monthsPaid);

    if (!Number.isFinite(remainingBuyout) || remainingBuyout <= 0) {
      return res.status(400).json({ error: "No remaining buyout balance" });
    }

    const displayName = order.pcName || "PC Rental";
    const image = order.image || "";

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: `${displayName} Buyout`,
              description: "Final ownership payment",
              images: image ? [image] : []
            },
            unit_amount: Math.round(remainingBuyout * 100)
          },
          quantity: 1
        }
      ],
      metadata: {
        type: "buyout",
        orderId,
        buyoutAmount: remainingBuyout.toFixed(2),
        monthsPaid: String(monthsPaid),
        pcValue: String(pcValue),
        ownershipRate: String(ownershipRate)
      },
      success_url: "https://rent-a-gaming-rig.com/success.html?buyout=true&session_id={CHECKOUT_SESSION_ID}",
      cancel_url: "https://rent-a-gaming-rig.com/orders.html?buyout=cancelled"
    });

    res.json({
      url: session.url,
      buyout: {
        orderId,
        displayName,
        remainingBuyout
      }
    });

  } catch (err) {
    console.error("BUYOUT ERROR:", err);
    res.status(err.statusCode || 500).json({
      error: err.message || "Stripe buyout session creation failed"
    });
  }
});

/* ================= CANCEL ORDER ================= */
app.post("/cancel-order", async (req, res) => {
  try {
    const authHeader = req.headers.authorization || "";
    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Missing auth token" });
    }
    let decodedToken;
    try {
      decodedToken = await admin.auth().verifyIdToken(authHeader.slice(7));
    } catch (err) {
      return res.status(401).json({ error: "Invalid or expired auth token" });
    }
    const { orderId } = req.body || {};
    if (!orderId || typeof orderId !== "string" || orderId.includes("/")) {
      return res.status(400).json({ error: "Missing or invalid orderId" });
    }

    const orderRef = db.collection("orders").doc(orderId);
    const orderSnap = await orderRef.get();

    if (!orderSnap.exists) {
      return res.status(404).json({ error: "Order not found" });
    }

    let order = orderSnap.data();

    const isAdmin = decodedToken.email === "noahlarson2009@gmail.com";
    if (order.userId !== decodedToken.uid && !isAdmin) {
      return res.status(403).json({ error: "Not your order" });
    }

    if (order.stripeSubscriptionId) {
      await syncOrderPayments(orderRef);
      order = (await orderRef.get()).data() || {};
    }

    if (order.cancelRefundProcessed === true) {
      return res.status(400).json({
        error: "Cancel refund was already processed for this order."
      });
    }

    const status = String(order.status || "").toLowerCase();
    if (["cancelled", "cancelling", "completed", "bought_out"].includes(status)) {
      return res.status(400).json({ error: "This order can no longer be cancelled." });
    }
    if (order.autoFinalBuyout === true) {
      const outcome = await db.runTransaction(async (tx) => {
        const currentSnap = await tx.get(orderRef);
        if (!currentSnap.exists) throw new Error("Order not found");
        const current = currentSnap.data() || {};
        if (current.autoFinalInvoiceId) return "final_in_progress";
        if (current.buyoutPaid || ["cancelled", "cancelling", "completed", "bought_out"].includes(String(current.status || "").toLowerCase())) return "ended";
        tx.update(orderRef, { autoBuyoutCancellationRequested: true });
        return "ok";
      });
      if (outcome === "final_in_progress") {
        return res.status(409).json({ error: "Your final payment is already being processed. Please contact Rent a Rig for cancellation assistance." });
      }
      if (outcome === "ended") return res.status(400).json({ error: "This order can no longer be cancelled." });
    }

    const refundIds = [];
    let refundAmount = 0;

    if (status === "pending") {
      if (!order.stripeSessionId) {
        throw new Error("Missing stripeSessionId on pending order.");
      }

      const session = await stripe.checkout.sessions.retrieve(order.stripeSessionId, {
        expand: ["payment_intent"]
      });

      let initialCharges = [];
      if (session.payment_intent) {
        const paymentIntent = await stripe.paymentIntents.retrieve(stripeObjectId(session.payment_intent), {
          expand: ["latest_charge"]
        });
        const charge = typeof paymentIntent.latest_charge === "object"
          ? paymentIntent.latest_charge
          : paymentIntent.latest_charge ? await stripe.charges.retrieve(paymentIntent.latest_charge) : null;
        if (charge?.id) initialCharges = [{ charge, allocation: Number(charge.amount || 0) }];
      } else if (order.stripeSubscriptionId) {
        // Subscription Checkout sessions keep their initial payment on the
        // first invoice rather than necessarily on session.payment_intent.
        const invoiceCharges = await getRentalInvoiceCharges(order.stripeSubscriptionId);
        for (const invoice of invoiceCharges) {
          const detail = await stripe.invoices.retrieve(invoice.invoiceId);
          if (detail.billing_reason === "subscription_create") {
            initialCharges = invoice.charges;
            break;
          }
        }
      }
      if (!initialCharges.length) throw new Error("No refundable initial payment found for this pending order.");

      const pendingChargeIds = new Set();
      for (const item of initialCharges) {
        if (pendingChargeIds.has(item.charge.id)) throw new Error("Duplicate initial payment requires manual review.");
        pendingChargeIds.add(item.charge.id);
        const prior = await getOrderRefundsForCharge(item.charge.id, orderId, "pending_order_full_refund");
        const priorAmount = prior.reduce((sum, refund) => sum + Number(refund.amount || 0), 0);
        refundIds.push(...prior.map((refund) => refund.id));
        refundAmount += priorAmount / 100;
        const chargeRemaining = Math.max(Number(item.charge.amount || 0) - Number(item.charge.amount_refunded || 0), 0);
        const amount = Math.min(Math.max(item.allocation - priorAmount, 0), chargeRemaining);
        if (amount <= 0 || prior.length) continue;
        const refund = await stripe.refunds.create({
          charge: item.charge.id,
          amount,
          metadata: { orderId, reason: "pending_order_full_refund" }
        }, { idempotencyKey: `pending-refund-${orderId}-${item.charge.id}` });
        refundIds.push(refund.id);
        refundAmount += amount / 100;
      }

      if (order.stripeSubscriptionId) {
        try {
          const subscription = await stripe.subscriptions.retrieve(order.stripeSubscriptionId);

          if (subscription.status !== "canceled") {
            await stripe.subscriptions.cancel(order.stripeSubscriptionId);
           }
        } catch (subErr) {
          const latest = await stripe.subscriptions.retrieve(order.stripeSubscriptionId);
          if (latest.status !== "canceled") throw subErr;
        }
      }  

      const pendingRefundedCredit = Math.max(
        Number(order.ownershipCreditRefunded || 0),
        Math.min(Number(order.ownershipRate || 0), refundAmount)
      );
      await orderRef.update({
        status: "cancelled",
        paymentStatus: "cancelled",
        cancelAtPeriodEnd: false,
        cancelRefundProcessed: true,
        cancelRefundAmount: refundAmount,
        cancelRefundIds: refundIds,
        ...(order.standardRent != null && order.buyout === true ? {
          ownershipCreditRefunded: pendingRefundedCredit,
          remainingBuyout: getRemainingBuyout({ ...order, ownershipCreditRefunded: pendingRefundedCredit }).toFixed(2)
        } : {}),
        cancelRefundedAt: admin.firestore.FieldValue.serverTimestamp(),
        cancelledAt: admin.firestore.FieldValue.serverTimestamp()
      });

      return res.json({
        success: true,
        refundAmount,
        refundIds
      });
    }

    if (!order.stripeSubscriptionId) {
      return res.status(400).json({ error: "Missing Stripe subscription ID on order" });
    }

    const monthsPaid = Number(order.monthsPaid || 0);
    const totalPerMonth = Number(order.totalPerMonth || 0);
    const rentPerMonth = Number(order.rentPerMonth || 0);

    // New orders save their actual rental-only rate. Keep the previous
    // calculation for older orders so their original terms are preserved.
    const savedBaseRent = Number(order.baseRent);
    const savedStandardRent = Number(order.standardRent);
    const normalBaseRent = order.standardRent != null && Number.isFinite(savedStandardRent)
      ? savedStandardRent
      : Number.isFinite(savedBaseRent) && savedBaseRent > 0
        ? savedBaseRent
        : order.buyout === true ? rentPerMonth + 25 : rentPerMonth;

    const extraPaidPerMonth = Math.max(totalPerMonth - normalBaseRent, 0);
    const perInvoiceRefund = Math.round(extraPaidPerMonth * 100);
    let remainingRefund = perInvoiceRefund * monthsPaid;

    if (remainingRefund > 0) {
      const invoices = await getRentalInvoiceCharges(order.stripeSubscriptionId);
      if (invoices.length !== monthsPaid) throw new Error("Rental payment count changed; please retry cancellation.");

      // Fetch previous refunds before issuing any new ones so a retry after a
      // partial failure cannot refund the same ownership payments twice.
      const seenCharges = new Set();
      for (const invoice of invoices) {
        invoice.alreadyRefunded = 0;
        for (const item of invoice.charges) {
          if (seenCharges.has(item.charge.id)) {
            throw new Error("A payment is shared by multiple rental invoices; manual refund review is required.");
          }
          seenCharges.add(item.charge.id);
          item.priorRefunds = await getOrderRefundsForCharge(item.charge.id, orderId);
          invoice.alreadyRefunded += item.priorRefunds.reduce((sum, refund) => sum + Number(refund.amount || 0), 0);
          refundIds.push(...item.priorRefunds.map((refund) => refund.id));
        }
        remainingRefund -= Math.min(perInvoiceRefund, invoice.alreadyRefunded);
      }

      for (const invoice of invoices) {
        let invoiceRemaining = Math.max(perInvoiceRefund - invoice.alreadyRefunded, 0);
        for (const item of invoice.charges) {
          if (invoiceRemaining <= 0 || remainingRefund <= 0) break;
          if (item.priorRefunds.length) continue;
          const chargeRemaining = Math.max(Number(item.charge.amount || 0) - Number(item.charge.amount_refunded || 0), 0);
          const amount = Math.min(invoiceRemaining, remainingRefund, item.allocation, chargeRemaining);
          if (amount <= 0) continue;
          const refund = await stripe.refunds.create({
            charge: item.charge.id,
            amount,
            metadata: { orderId, invoiceId: invoice.invoiceId, reason: "rent_to_own_extra_cancel_refund" }
          }, { idempotencyKey: `cancel-refund-${orderId}-${invoice.invoiceId}-${item.charge.id}` });
          refundIds.push(refund.id);
          invoiceRemaining -= amount;
          remainingRefund -= amount;
        }
      }
    }

    refundAmount = Math.round(extraPaidPerMonth * monthsPaid * 100) - remainingRefund;
    // Only new pricing records receive the revised credit accounting.
    const refundedCredit = order.standardRent != null && order.buyout === true
      ? Math.max(Number(order.ownershipCreditRefunded || 0), refundAmount / 100)
      : Number(order.ownershipCreditRefunded || 0);

    const latestSubscription = await stripe.subscriptions.retrieve(order.stripeSubscriptionId);

    if (latestSubscription.status === "canceled") {
      await orderRef.update({
        status: "cancelled",
        paymentStatus: "cancelled",
        cancelAtPeriodEnd: false,
        cancelRefundProcessed: true,
        cancelRefundAmount: refundAmount / 100,
        cancelRefundRemaining: remainingRefund / 100,
        cancelRefundIds: refundIds,
        ownershipCreditRefunded: refundedCredit,
        remainingBuyout: getRemainingBuyout({ ...order, ownershipCreditRefunded: refundedCredit }, monthsPaid).toFixed(2),
        cancelRefundedAt: admin.firestore.FieldValue.serverTimestamp(),
        cancelledAt: admin.firestore.FieldValue.serverTimestamp()
      });

      return res.json({
        success: true,
        refundAmount: refundAmount / 100,
        refundRemaining: remainingRefund / 100,
        refundIds
      });
    }

    await stripe.subscriptions.update(order.stripeSubscriptionId, {
      cancel_at_period_end: true
    });   

    await orderRef.update({
      status: "cancelling",
      cancelAtPeriodEnd: true,
      cancelRefundProcessed: true,
      cancelRefundAmount: refundAmount / 100,
      cancelRefundRemaining: remainingRefund / 100,
      cancelRefundIds: refundIds,
      ownershipCreditRefunded: refundedCredit,
      remainingBuyout: getRemainingBuyout({ ...order, ownershipCreditRefunded: refundedCredit }, monthsPaid).toFixed(2),
      cancelRefundedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({
      success: true,
      refundAmount: refundAmount / 100,
      refundRemaining: remainingRefund / 100,
      refundIds
    });

  } catch (err) {
    console.error("CANCEL ORDER ERROR:", err);
    res.status(500).json({
      error: err.message || "Cancel failed"
    });
  }
});

/* ================= CUSTOM BUILD TO RENTAL (ADMIN ONLY) ================= */
app.post("/custom-build-to-rental", async (req, res) => {
  try {
    const authHeader = req.headers.authorization || "";

    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Missing auth token" });
    }

    const idToken = authHeader.split("Bearer ")[1];
    const decodedToken = await admin.auth().verifyIdToken(idToken);

    if (decodedToken.email !== "noahlarson2009@gmail.com") {
      return res.status(403).json({ error: "Only the admin can make rentals" });
    }

    const { orderId, monthlyPrice } = req.body;
    const priceNumber = Number(monthlyPrice);

    if (!orderId || typeof orderId !== "string") {
      return res.status(400).json({ error: "Missing orderId" });
    }

    if (!Number.isFinite(priceNumber) || priceNumber <= 0) {
      return res.status(400).json({ error: "Invalid monthly price" });
    }

    const orderRef = db.collection("orders").doc(orderId);
    const orderSnap = await orderRef.get();

    if (!orderSnap.exists) {
      return res.status(404).json({ error: "Order not found" });
    }

    const order = orderSnap.data() || {};

    if (order.orderType !== "custom_build_deposit") {
      return res.status(400).json({ error: "This is not a custom build order" });
    }

    await orderRef.update({
      orderType: "rental",
      pcName: "Custom PC Rental",

      totalPerMonth: priceNumber,
      rentPerMonth: priceNumber,
      months: 12,
      monthsPaid: 0,

      buyout: false,
      paymentStatus: "pending",
      status: "pending",

      convertedFromCustomBuild: true,
      convertedFromCustomBuildAt: admin.firestore.FieldValue.serverTimestamp(),
      rentalCreatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    await mailer.sendMail({
      from: process.env.EMAIL_USER,
      to: order.userEmail,
      bcc: process.env.BUSINESS_EMAIL || "",
      subject: "Your Custom PC Rental Order Is Ready",
      text: `
Hello ${order.fullName || ""},

Your custom PC build has been turned into a rental order.

Monthly price: $${priceNumber.toFixed(2)}

Log in and view your order here:
https://rent-a-gaming-rig.com/orders.html

Your order is pending until it is activated.

Thank you.
      `.trim()
    });

    res.json({
      success: true
    });

  } catch (err) {
    console.error("CUSTOM BUILD TO RENTAL ERROR:", err);
    res.status(500).json({
      error: err.message || "Failed to make custom build into rental"
    });
  }
});

/* ================= FINISH BUILD ================= */
app.post("/finish-build", async (req, res) => {
  try {
    const authHeader = req.headers.authorization || "";

    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Missing token" });
    }

    const idToken = authHeader.split("Bearer ")[1];
    const decoded = await admin.auth().verifyIdToken(idToken);

    if (decoded.email !== "noahlarson2009@gmail.com") {
      return res.status(403).json({ error: "Admin only" });
    }

    const { orderId, image, pcValue } = req.body;
    const value = Number(pcValue);

    if (!orderId || !image || !Number.isFinite(value) || value <= 0) {
      return res.status(400).json({ error: "Missing data or invalid PC value" });
    }
    const baseRent = Math.ceil((value / 12) / 5) * 5;
    const standardRent = baseRent - Math.floor((baseRent * 0.40) / 5) * 5;

    const ref = db.collection("orders").doc(orderId);

    const orderSnap = await ref.get();

    if (!orderSnap.exists) {
      return res.status(404).json({ error: "Order not found" });
    }

    const order = orderSnap.data() || {};

    await ref.update({
      readyForRent: true,
      image,
      pcValue: value,
      baseRent,
      totalPerMonth: standardRent,
      rentPerMonth: standardRent,
      finishedAt: admin.firestore.FieldValue.serverTimestamp(),
      finishedEmailSent: true,
      finishedEmailSentAt: admin.firestore.FieldValue.serverTimestamp()
    });

    await mailer.sendMail({
      from: process.env.EMAIL_USER,
      to: order.userEmail,
      bcc: process.env.BUSINESS_EMAIL || "",
      subject: "Your Custom PC Build Is Finished",
      text: `
Hello ${order.fullName || ""},

Your custom PC build is finished and ready to rent.

Standard rent: $${standardRent.toFixed(2)}/month
Rent-to-own: from $${baseRent.toFixed(2)}/month

You can view and rent it from your orders page here:
https://rent-a-gaming-rig.com/orders.html

Thank you.
      `.trim()
    });

    res.json({ success: true });

  } catch (err) {
    console.error("FINISH BUILD ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

/* ================= ACTIVATE ORDER (ADMIN ONLY) ================= */
app.post("/activate-order", async (req, res) => {
  try {
    const authHeader = req.headers.authorization || "";

    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Missing auth token" });
    }

    const idToken = authHeader.split("Bearer ")[1];
    const decodedToken = await admin.auth().verifyIdToken(idToken);

    if (decodedToken.email !== "noahlarson2009@gmail.com") {
      return res.status(403).json({ error: "Only the admin can activate orders" });
    }

    const { orderId } = req.body;

    if (!orderId || typeof orderId !== "string") {
      return res.status(400).json({ error: "Missing orderId" });
    }

    const orderRef = db.collection("orders").doc(orderId);
    const orderSnap = await orderRef.get();

    if (!orderSnap.exists) {
      return res.status(404).json({ error: "Order not found" });
    }

    await orderRef.update({
      status: "active",
      activatedAt: admin.firestore.FieldValue.serverTimestamp(),
      activatedBy: decodedToken.uid
    });

    res.json({ success: true });

  } catch (err) {
    console.error("ACTIVATE ORDER ERROR:", err);
    res.status(500).json({
      error: err.message || "Failed to activate order"
    });
  }
});

/* ================= DELETE ORDER (ADMIN ONLY) ================= */
app.post("/delete-order", async (req, res) => {
  try {
    const authHeader = req.headers.authorization || "";

    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Missing auth token" });
    }

    const idToken = authHeader.split("Bearer ")[1];
    const decodedToken = await admin.auth().verifyIdToken(idToken);

    if (decodedToken.email !== "noahlarson2009@gmail.com") {
      return res.status(403).json({ error: "Only the admin can delete orders" });
    }

    const { orderId } = req.body;

    if (!orderId || typeof orderId !== "string") {
      return res.status(400).json({ error: "Missing orderId" });
    }

    const orderRef = db.collection("orders").doc(orderId);
    const orderSnap = await orderRef.get();

    if (!orderSnap.exists) {
      return res.status(404).json({ error: "Order not found" });
    }

    await orderRef.delete();

    res.json({ success: true });
  } catch (err) {
    console.error("DELETE ORDER ERROR:", err);
    res.status(500).json({
      error: err.message || "Failed to delete order"
    });
  }
});

/* ================= START SERVER ================= */
const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
