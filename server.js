const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");
require("dotenv").config();

const app = express();

app.use(cors({ origin: "*" }));

// Dedicated signed Stripe webhook for mobile appointment payments.
let mobilePayments;
app.post("/api/mobile/stripe-webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const secret = process.env.MOBILE_STRIPE_WEBHOOK_SECRET;
  if (!secret || !mobilePayments) return res.status(503).send("Mobile payment webhook is not configured");
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], secret);
  } catch {
    return res.status(400).send("Invalid webhook signature");
  }
  try {
    await mobilePayments.webhook(event);
    return res.json({ received: true });
  } catch (err) {
    console.error("Mobile payment webhook failed:", err.code || err.status || err.name);
    return res.status(500).send("Payment update needs retry");
  }
});

// ================= WEBHOOK (MUST BE BEFORE express.json) =================
app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const event = JSON.parse(req.body.toString());

    console.log("WEBHOOK RECEIVED:", event.type);

    // The legacy custom-build flow is disabled. Do not create a new order if
    // an old Stripe event is replayed after this deployment.
    if (
      event.type === "checkout.session.completed" &&
      event.data?.object?.metadata?.type === "custom_build_deposit"
    ) {
      console.log("Ignoring disabled custom-build deposit event:", event.data.object.id);
      return res.json({ received: true });
    }

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

    if (event.type === "invoice.payment_succeeded" || event.type === "invoice.paid") {
        const invoice = event.data.object;
        const invoiceId = invoice.id;

        if (!invoiceId) {
            console.log("No invoice ID found.");
            return res.json({ received: true });
        }
        const sub =
            invoice.subscription ||
            invoice.parent?.subscription_details?.subscription ||
            invoice.lines?.data?.[0]?.parent?.subscription_item_details?.subscription ||
            null;

        console.log("invoice.payment_succeeded subscription:", sub);

        if (!sub) {
            console.log("No subscription ID on invoice.");
            return res.json({ received: true });
        }

        const snap = await db.collection("orders")
            .where("stripeSubscriptionId", "==", sub)
            .get();

        console.log("Matching orders found:", snap.size);

        for (const docSnap of snap.docs) {
            const order = docSnap.data();

            const paidInvoiceIds = Array.isArray(order.paidInvoiceIds)
                ? order.paidInvoiceIds
                : [];

            if (paidInvoiceIds.includes(invoiceId)) {
                console.log("Invoice already counted:", invoiceId);
                continue;
            }

            const oldMonthsPaid = Number(order.monthsPaid || 0);
            const totalMonths = Number(order.months || 0);
            const newMonthsPaid = oldMonthsPaid + 1;

            console.log(
                "Updating order",
                docSnap.id,
                "from",
                oldMonthsPaid,
                "to",
                newMonthsPaid,
                "out of",
                totalMonths
            );

            await docSnap.ref.update({
                monthsPaid: newMonthsPaid,
                paidInvoiceIds: [...paidInvoiceIds, invoiceId], // ✅ THIS FIXES IT
                paymentStatus: "paid",
                missedPaymentResolved: true,
                missedPaymentDeadlineMs: admin.firestore.FieldValue.delete(),
                returnRequired: false,
                status: order.status === "payment_overdue" ? "active" : order.status
            });

                        if (totalMonths > 0 && newMonthsPaid >= totalMonths) {
                await stripe.subscriptions.cancel(sub);

                await docSnap.ref.update({
                    cancelAtPeriodEnd: false,
                    status: "completed",
                    buyoutEmailSent: true,
                    buyoutEmailSentAt: admin.firestore.FieldValue.serverTimestamp()
                });

                if (order.buyout === true && order.buyoutEmailSent !== true) {
                    try {
                        await sendBuyoutReadyEmail(
                            {
                                ...order,
                                monthsPaid: newMonthsPaid
                            },
                            docSnap.id
                        );

                        console.log("BUYOUT EMAIL SENT TO:", order.userEmail);
                    } catch (emailErr) {
                        console.error("BUYOUT EMAIL ERROR:", emailErr);
                    }
                }

                console.log("Subscription cancelled after exact payment count:", sub);
            }
        }

        if (snap.empty) {
            console.log("No order matched stripeSubscriptionId =", sub);
        }
    }

    if (event.type === "invoice.payment_failed") {
        const invoice = event.data.object;
        const sub =
            invoice.subscription ||
            invoice.parent?.subscription_details?.subscription ||
            invoice.lines?.data?.[0]?.parent?.subscription_item_details?.subscription ||
            null;

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
                await docSnap.ref.update({
                    cancelAtPeriodEnd: true,
                    status: "cancelling"
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
                paymentStatus: "cancelled",
                status: monthsPaid >= totalMonths ? "completed" : "cancelled",
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
app.use(express.json({ limit: "32kb" }));

// Disable new custom computer orders, including direct API requests.
app.post(["/custom-build-deposit", "/custom-build-to-rental", "/finish-build"], (req, res) => {
  res.status(410).json({ error: "Custom computer orders are unavailable. Mobile assembly uses customer-provided parts." });
});
app.post("/checkout", (req, res, next) => {
  if (req.body?.originalCustomBuildOrderId) {
    return res.status(410).json({ error: "Custom computer checkout is unavailable." });
  }
  next();
});

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error("Missing STRIPE_SECRET_KEY in .env");
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
  const remainingBuyout = Math.max(pcValue - (ownershipRate * monthsPaid), 0);

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

function buildPricing({ baseRent, pcValue, months, buyout, ownershipExtra }) {

  const ownershipRate = buyout
    ? Number(ownershipExtra || 0)
    : 0;

  // Remove 20% from normal rent when rent-to-own is enabled
  const discountedRent = buyout
    ? baseRent * 0.8
    : baseRent;

  // Add ownership credit after discount
  const totalPerMonth = buyout
    ? discountedRent + ownershipRate
    : baseRent;

  const rentPerMonth = discountedRent;

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
  const baseRent = Math.ceil((displayValue / 18) / 5) * 5;

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
      baseRent = Number(orderData.totalPerMonth || 0);
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

    if (!Number.isFinite(totalPerMonth) || totalPerMonth <= 0) {
      return res.status(400).json({ error: "Calculated monthly total is invalid" });
    }

    let pcRef = null;

    if (!isCustomBuild) {
      pcRef = db.collection("pcs").doc(pcId);

      const pcSnap = await pcRef.get();

      if (!pcSnap.exists) {
        return res.status(404).json({ error: "PC not found" });
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
                            `Base Rent: $${(safeBuyout ? baseRent * 0.8 : baseRent).toFixed(2)}/mo`,
                            `Buyout: ${safeBuyout ? "Enabled" : "Disabled"}`,
                            `Months Selected: ${safeMonths}`,
                            `Ownership Credit: $${ownershipRate.toFixed(2)}/mo`,
                            `Remaining Buyout After Term: $${remainingBuyout.toFixed(2)}`
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
                        rentPerMonth: rentPerMonth.toFixed(2),
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
    const isOneMonth = months <= 1;

    const remainingBuyout = Math.max(
      Number(metadata.pcValue || 0) -
      (Number(metadata.ownershipRate || 0) * 1),
      0
    );

    if (subscriptionId && isOneMonth) {
      await stripe.subscriptions.cancel(subscriptionId);
    }

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
      buyout: metadata.buyout === "true",
      multiplier: Number(metadata.multiplier || 1),
      ownershipRate: Number(metadata.ownershipRate || 0),
      remainingBuyout: remainingBuyout.toFixed(2),
      rentPerMonth: Number(metadata.rentPerMonth || 0),
      totalPerMonth: Number(metadata.totalPerMonth || 0),
      paymentStatus: isOneMonth ? "cancelled" : "paid",
      status: isOneMonth ? "completed" : "pending",
      stripeSubscriptionId: subscriptionId || "",
      cancelledAt: isOneMonth ? Date.now() : null
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

        if (existingOrder.exists) {
            return;
        }

        let pcSnap = null;

        if (pcRef) {
            pcSnap = await tx.get(pcRef);

            if (!pcSnap.exists) {
                throw new Error("PC listing not found.");
            }
        }    

        tx.set(orderRef, {
            ...order,
            stripeSessionId: sessionId,
            status: order.status || "pending",
            paymentStatus: order.paymentStatus || "paid",
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

    res.json({
      paid: true,
      order
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

    const order = orderSnap.data() || {};
    const status = String(order.status || "").toLowerCase();
    const monthsPaid = Number(order.monthsPaid || 0);

    const isAdmin = decodedToken.email === "noahlarson2009@gmail.com";
    if (order.userId !== decodedToken.uid && !isAdmin) {
      return res.status(403).json({ error: "Not your order" });
    }

    if (!order.buyout) {
      return res.status(400).json({ error: "Buyout is not enabled for this order" });
    }

    if (order.buyoutPaid === true || status === "bought_out") {
      return res.status(400).json({ error: "This order has already been bought out" });
    }

    if (monthsPaid < 3) {
      return res.status(400).json({
        error: "Buyout unlocks after 3 months of payments."
      });
    }

    // 🔥 allow active orders too
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

    const remainingBuyout = Math.max(
        pcValue - (ownershipRate * monthsPaid),
        0
    );

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
    const { orderId, userId } = req.body;

    const orderRef = db.collection("orders").doc(orderId);
    const orderSnap = await orderRef.get();

    if (!orderSnap.exists) {
      return res.status(404).json({ error: "Order not found" });
    }

    const order = orderSnap.data();

    if (order.userId !== userId && order.userEmail !== req.body.email) {
      return res.status(403).json({ error: "Not your order" });
    }

    if (order.cancelRefundProcessed === true) {
      return res.status(400).json({
        error: "Cancel refund was already processed for this order."
      });
    }

    const status = String(order.status || "").toLowerCase();
    const refundIds = [];
    let refundAmount = 0;

    if (status === "pending") {
      if (!order.stripeSessionId) {
        throw new Error("Missing stripeSessionId on pending order.");
      }

      const session = await stripe.checkout.sessions.retrieve(order.stripeSessionId, {
        expand: ["payment_intent"]
      });

      if (!session.payment_intent) {
        throw new Error("No payment intent found on Stripe checkout session.");
      }

      const paymentIntentId =
        typeof session.payment_intent === "object"
          ? session.payment_intent.id
          : session.payment_intent;

      const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId, {
        expand: ["latest_charge"]
      });

      const charge = paymentIntent.latest_charge;

      if (!charge || !charge.id) {
        throw new Error("No charge found on payment intent.");
      }

      const alreadyRefunded = Number(charge.amount_refunded || 0);
      const chargeAmount = Number(charge.amount || 0);
      const refundableAmount = Math.max(chargeAmount - alreadyRefunded, 0);

      if (refundableAmount <= 0) {
        throw new Error("This pending order payment is already fully refunded.");
      }

      const refund = await stripe.refunds.create({
        charge: charge.id,
        amount: refundableAmount,
        metadata: {
          orderId,
          reason: "pending_order_full_refund"
        }
      });

      refundIds.push(refund.id);
      refundAmount = refundableAmount / 100;

      if (order.stripeSubscriptionId) {
        try {
          const subscription = await stripe.subscriptions.retrieve(order.stripeSubscriptionId);

          if (subscription.status !== "canceled") {
            await stripe.subscriptions.cancel(order.stripeSubscriptionId);
           }
        } catch (subErr) {
          console.log("Subscription already cancelled or unavailable:", subErr.message);
        }
      }  

      await orderRef.update({
        status: "cancelled",
        paymentStatus: "cancelled",
        cancelAtPeriodEnd: false,
        cancelRefundProcessed: true,
        cancelRefundAmount: refundAmount,
        cancelRefundIds: refundIds,
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

    const normalBaseRent = order.buyout === true
      ? rentPerMonth + 25
      : rentPerMonth;

    const extraPaidPerMonth = Math.max(totalPerMonth - normalBaseRent, 0);
    let remainingRefund = Math.round(extraPaidPerMonth * monthsPaid * 100);

    const subscription = await stripe.subscriptions.retrieve(order.stripeSubscriptionId);

    if (!subscription.customer) {
      throw new Error("No Stripe customer found on subscription.");
    }

    const charges = await stripe.charges.list({
      customer: subscription.customer,
      limit: 100
    });

    for (const charge of charges.data) {
      if (remainingRefund <= 0) break;
      if (charge.status !== "succeeded") continue;

      const alreadyRefunded = Number(charge.amount_refunded || 0);
      const chargeAmount = Number(charge.amount || 0);
      const refundableAmount = Math.max(chargeAmount - alreadyRefunded, 0);

      if (refundableAmount <= 0) continue;

      const amountToRefund = Math.min(remainingRefund, refundableAmount);

      const refund = await stripe.refunds.create({
        charge: charge.id,
        amount: amountToRefund,
        metadata: {
          orderId,
          reason: "rent_to_own_extra_cancel_refund"
        }
      });

      refundIds.push(refund.id);
      remainingRefund -= amountToRefund;
    }

    const latestSubscription = await stripe.subscriptions.retrieve(order.stripeSubscriptionId);

    if (latestSubscription.status === "canceled") {
      await orderRef.update({
        status: "cancelled",
        paymentStatus: "cancelled",
        cancelAtPeriodEnd: false,
        cancelRefundProcessed: true,
        cancelRefundAmount: refundAmount / 100,
        cancelRefundIds: refundIds,
        cancelRefundedAt: admin.firestore.FieldValue.serverTimestamp(),
        cancelledAt: admin.firestore.FieldValue.serverTimestamp()
      });

      return res.json({
        success: true,
        refundAmount: refundAmount / 100,
        refundIds
      });
    }

    await stripe.subscriptions.update(order.stripeSubscriptionId, {
      cancel_at_period_end: true
    });   

    refundAmount = Math.round(extraPaidPerMonth * monthsPaid * 100) - remainingRefund;

    await orderRef.update({
      status: "cancelling",
      cancelAtPeriodEnd: true,
      cancelRefundProcessed: true,
      cancelRefundAmount: refundAmount / 100,
      cancelRefundIds: refundIds,
      cancelRefundedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({
      success: true,
      refundAmount: refundAmount / 100,
      refundIds
    });

  } catch (err) {
    console.error("CANCEL ORDER ERROR:", err);
    res.status(500).json({
      error: err.message || "Cancel failed"
    });
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


/* ================= MOBILE SERVICES AND PAYMENTS ================= */
(() => {
const crypto = require("node:crypto");
const TZ = "America/Chicago";
const FEES = { diagnostic: [2000, 30], assembly: [5000, 60], both: [7000, 90] };
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const clock = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
});
function parts(seconds) {
  return Object.fromEntries(clock.formatToParts(new Date(seconds * 1000)).map(p => [p.type, p.value]));
}
function dateAt(seconds) {
  const p = parts(seconds); return `${p.year}-${p.month}-${p.day}`;
}
function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw fail("Choose a valid date.");
  const d = new Date(value + "T12:00:00Z");
  if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== value) throw fail("Choose a valid date.");
  return value;
}
// Convert local Central Time to an epoch without assuming a fixed UTC offset.
function epoch(day, minute) {
  const target = Date.parse(day + "T00:00:00Z") / 1000 + minute * 60;
  let result = target;
  for (let i = 0; i < 4; i++) {
    const p = parts(result);
    const shown = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`) / 1000;
    const correction = target - shown;
    result += correction;
    if (!correction) break;
  }
  const p = parts(result);
  return dateAt(result) === day && Number(p.hour) * 60 + Number(p.minute) === minute ? result : null;
}
function clean(body, name, max, min = 1) {
  const v = body[name];
  if (typeof v !== "string" || v.trim().length < min || v.trim().length > max) throw fail(`Check the ${name} field.`);
  return v.trim();
}
function checkSettings(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw fail("Invalid schedule.");
  const hours = {};
  for (const [day, ranges] of Object.entries(input.hours || {})) {
    if (!/^[0-6]$/.test(day) || !Array.isArray(ranges) || ranges.length > 4) throw fail("Invalid working hours.");
    hours[day] = ranges.map(range => {
      if (!Array.isArray(range) || range.length !== 2 || !range.every(t => typeof t === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(t)) || range[0] >= range[1]) throw fail("Hours must start and finish on the same day, with closing after opening.");
      return range;
    }).sort((a, b) => a[0].localeCompare(b[0]));
    for (let i = 1; i < hours[day].length; i++) if (hours[day][i][0] < hours[day][i - 1][1]) throw fail("Working windows cannot overlap.");
  }
  const closedDates = input.closedDates || [];
  if (!Array.isArray(closedDates) || closedDates.length > 200) throw fail("Invalid closed dates.");
  closedDates.forEach(validDate);
  return { hours, closedDates };
}
function available(q, day, settings, bookings, now = Date.now() / 1000, leadSeconds = 3600) {
  validDate(day);
  if (day < dateAt(now) || day > dateAt(now + 60 * 86400)) throw fail("Choose a date within the next 60 days.");
  if (settings.closedDates.includes(day)) return [];
  // Monday=0 through Sunday=6.
  const weekday = (new Date(day + "T12:00:00Z").getUTCDay() + 6) % 7;
  const minutes = t => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
  const windows = (settings.hours[weekday] || []).map(([a, b]) => [epoch(day, minutes(a)), epoch(day, minutes(b))]).filter(w => w.every(v => v !== null));
  const result = [];
  for (let m = 0; m < 1440; m += 15) {
    const arrival = epoch(day, m);
    if (arrival === null) continue;
    const start = arrival - q.outMinutes * 60;
    // Conservative allowance requested by owner: keep the full round trip
    // plus service unavailable after the selected appointment time. The next
    // appointment also needs its outbound drive before its selected time.
    const end = arrival + (q.outMinutes + FEES[q.service][1] + q.backMinutes) * 60;
    if (start < now + leadSeconds || !windows.some(([a, b]) => start >= a && end <= b)) continue;
    if (bookings.some(b => (!b.holdUntil || b.holdUntil > now) && start < b.end && end > b.start)) continue;
    result.push({ arrival, label: new Date(arrival * 1000).toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" }) });
  }
  return result;
}
function register({ app, db, admin, stripe, env = process.env, fetchImpl = globalThis.fetch }) {
  const store = db.collection("mobileServicePrivate");
  const settingsRef = store.doc("settings");
  const now = () => Date.now() / 1000;
  const adminEmail = env.MOBILE_ADMIN_EMAIL || "noahlarson2009@gmail.com";
  const wrap = fn => async (req, res) => {
    res.set("Cache-Control", "no-store");
    try { res.json(await fn(req)); }
    catch (e) {
      if (!e.status) console.error("Mobile service request failed:", e.code || e.name);
      res.status(e.status || 500).json({ error: e.status ? e.message : "Unable to complete this request. Please try again or email us." });
    }
  };
  const key = () => {
    if (!env.MOBILE_BOOKING_SECRET || env.MOBILE_BOOKING_SECRET.length < 32) throw fail("Online booking is not connected yet. Please email rentarig21@gmail.com.", 503);
    return crypto.createHash("sha256").update("mobile-pc-v1:" + env.MOBILE_BOOKING_SECRET).digest();
  };
  // Encrypted authenticated quotes: no private origin or API key is sent to the browser.
  function seal(q) {
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
    const bytes = Buffer.concat([cipher.update(JSON.stringify(q), "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString("base64url");
  }
  function unseal(token) {
    const secret = key();
    try {
      if (typeof token !== "string" || token.length > 5000) throw Error();
      const bytes = Buffer.from(token, "base64url"), decipher = crypto.createDecipheriv("aes-256-gcm", secret, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      const q = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8"));
      if (!FEES[q.service] || !/^[a-f0-9]{32}$/.test(q.nonce)) throw Error();
      return q;
    } catch { throw fail("Please calculate a new estimate.", 410); }
  }
  const quoteFresh = q => { if (q.expires < now()) throw fail("Your quote expired. Please calculate a new estimate.", 410); };
  async function route(from, to) {
    if (!env.MOBILE_ORIGIN_ADDRESS || !env.GOOGLE_MAPS_API_KEY) throw fail("Online estimates are not connected yet. Please email rentarig21@gmail.com.", 503);
    try {
      const r = await fetchImpl("https://routes.googleapis.com/directions/v2:computeRoutes", {
        method: "POST", signal: AbortSignal.timeout(20000),
        headers: { "Content-Type": "application/json", "X-Goog-Api-Key": env.GOOGLE_MAPS_API_KEY, "X-Goog-FieldMask": "routes.distanceMeters,routes.duration" },
        body: JSON.stringify({ origin: { address: from }, destination: { address: to }, travelMode: "DRIVE", routingPreference: "TRAFFIC_UNAWARE" })
      });
      if (!r.ok) throw Error();
      const data = (await r.json()).routes?.[0];
      const meters = Number(data?.distanceMeters), seconds = Number(data?.duration?.replace(/s$/, ""));
      if (!Number.isFinite(meters) || meters < 0 || !Number.isFinite(seconds) || seconds < 0) throw Error();
      return { meters, minutes: Math.ceil(seconds / 60) };
    } catch { throw fail("Could not calculate that route. Check the complete address and ZIP or email us for a quote.", 422); }
  }
  // Basic per-process limit. The key is the socket peer, not an untrusted forwarded header.
  let period = 0, total = 0; const counts = new Map();
  function limit(req) {
    const hour = Math.floor(now() / 3600);
    if (hour !== period) { period = hour; total = 0; counts.clear(); }
    const peer = req.socket?.remoteAddress || "unknown";
    const count = (counts.get(peer) || 0) + 1; counts.set(peer, count); total++;
    if (count > 240 || total > 2000) throw fail("Too many requests. Please try later or email us.", 429);
  }
  const readSettings = snap => {
    const stored = snap.exists ? snap.data() : { hours: {}, closedDates: [] };
    const hours = Object.fromEntries(
      Object.entries(stored.hours || {}).map(([day, ranges]) => [
        day,
        ranges.map(range => Array.isArray(range) ? range : [range.start, range.end])
      ])
    );
    return checkSettings({ hours, closedDates: stored.closedDates || [] });
  };
  const recordSummary = b => ({ id: b.id, totalCents: b.totalCents, label: new Date(b.arrival * 1000).toLocaleString("en-US", { timeZone: TZ, weekday: "long", month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) });
  async function authorize(req) {
    const header = req.headers.authorization || "";
    if (!header.startsWith("Bearer ")) throw fail("Sign in with your owner account.", 401);
    let user;
    try { user = await admin.auth().verifyIdToken(header.slice(7), true); }
    catch { throw fail("Please sign in again.", 401); }
    if (user.email !== adminEmail || user.email_verified !== true) throw fail("Owner access only.", 403);
    return user;
  }
  const bookingRef = id => store.doc("booking_" + id);
  const validId = id => {
    if (typeof id !== "string" || !/^[a-f0-9]{32}$/.test(id)) throw fail("Invalid appointment.");
    return id;
  };
  const validSessionId = value => {
    if (typeof value !== "string" || !/^cs_[A-Za-z0-9_]+$/.test(value)) throw fail("Open the private appointment link you received after payment.", 403);
    return value;
  };
  const tokenFor = id => crypto.createHmac("sha256", key()).update("manage-mobile:" + id).digest("hex");
  const draftCanonical = draft => JSON.stringify([
    draft.q.nonce, draft.q.address, draft.q.service, draft.q.miles, draft.q.travelCents,
    draft.q.outMinutes, draft.q.backMinutes, draft.q.expires, draft.arrival,
    draft.name, draft.email, draft.phone, draft.notes
  ]);
  const draftSignature = draft => crypto.createHmac("sha256", key()).update("mobile-draft-v2:" + draftCanonical(draft)).digest("hex");
  function metadataForDraft(q, arrival, name, email, phone, notes) {
    const draft = { q, arrival, name, email, phone, notes };
    const metadata = {
      type: "mobile_service", mobileBookingId: q.nonce, address: q.address,
      service: q.service, miles: String(q.miles), travelCents: String(q.travelCents),
      outMinutes: String(q.outMinutes), backMinutes: String(q.backMinutes),
      quoteExpires: String(q.expires), arrival: String(arrival), name, email, phone,
      signature: draftSignature(draft)
    };
    for (let i = 0; i < notes.length; i += 450) metadata["notes" + Math.floor(i / 450)] = notes.slice(i, i + 450);
    return metadata;
  }
  function draftFromMetadata(metadata) {
    if (!metadata || metadata.type !== "mobile_service") throw fail("Payment details could not be verified.", 409);
    const q = {
      nonce: validId(metadata.mobileBookingId), address: metadata.address, service: metadata.service,
      miles: Number(metadata.miles), travelCents: Number(metadata.travelCents),
      outMinutes: Number(metadata.outMinutes), backMinutes: Number(metadata.backMinutes),
      expires: Number(metadata.quoteExpires)
    };
    if (typeof q.address !== "string" || q.address.length < 12 || q.address.length > 300 || !FEES[q.service] ||
        !Number.isFinite(q.miles) || q.miles < 0 || q.miles > 1000 || q.travelCents !== Math.round(q.miles * 50) ||
        !Number.isSafeInteger(q.outMinutes) || q.outMinutes < 0 || q.outMinutes > 100000 ||
        !Number.isSafeInteger(q.backMinutes) || q.backMinutes < 0 || q.backMinutes > 100000 ||
        !Number.isFinite(q.expires)) throw fail("Payment details could not be verified.", 409);
    const arrival = Number(metadata.arrival);
    const name = metadata.name, email = metadata.email, phone = metadata.phone;
    if (!Number.isSafeInteger(arrival) || arrival < 0 || arrival > 4102444800 ||
        typeof name !== "string" || name.length < 1 || name.length > 100 ||
        typeof email !== "string" || email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
        typeof phone !== "string" || phone.length < 7 || phone.length > 40) throw fail("Payment details could not be verified.", 409);
    const noteParts = [];
    for (let i = 0; i < 5; i++) {
      const part = metadata["notes" + i];
      if (part === undefined) break;
      if (typeof part !== "string" || part.length > 450) throw fail("Payment details could not be verified.", 409);
      noteParts.push(part);
    }
    const notes = noteParts.join("");
    if (notes.length > 2000 || metadata.notes5 !== undefined) throw fail("Payment details could not be verified.", 409);
    const draft = { q, arrival, name, email, phone, notes };
    if (typeof metadata.signature !== "string" || !/^[a-f0-9]{64}$/.test(metadata.signature)) throw fail("Payment details could not be verified.", 409);
    const expected = draftSignature(draft);
    if (!crypto.timingSafeEqual(Buffer.from(metadata.signature, "hex"), Buffer.from(expected, "hex"))) throw fail("Payment details could not be verified.", 409);
    return { ...draft, totalCents: q.travelCents + FEES[q.service][0] };
  }
  function manageUrl(value, options = {}) {
    const id = typeof value === "string" ? value : value.id;
    if (typeof options === "boolean") options = { canceled: options };
    const origin = (env.MOBILE_SITE_URL || "https://rent-a-gaming-rig.com").replace(/\/$/, "");
    const query = [];
    if (options.canceled) query.push("checkout=cancelled");
    if (options.sessionPlaceholder) query.push("session_id={CHECKOUT_SESSION_ID}");
    if (options.sessionId) query.push("session_id=" + encodeURIComponent(options.sessionId));
    return `${origin}/appointment.html${query.length ? "?" + query.join("&") : ""}#id=${id}&token=${tokenFor(id)}`;
  }
  async function authorizeCustomer(req) {
    const id = validId(req.body.id), token = req.body.token;
    if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token) ||
        !crypto.timingSafeEqual(Buffer.from(token, "hex"), Buffer.from(tokenFor(id), "hex"))) {
      throw fail("Open the private appointment link you received at checkout.", 403);
    }
    const booking = await bookingRef(id).get();
    if (booking.exists) return { id, booking: booking.data(), session: null };
    const sessionId = validSessionId(req.body.sessionId);
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (!session || session.metadata?.type !== "mobile_service" || session.metadata.mobileBookingId !== id) throw fail("This payment link does not match the appointment.", 403);
    return { id, booking: null, session };
  }
  const customerSummary = b => ({
    ...recordSummary(b), service: b.service, status: b.status,
    paymentStatus: b.paymentStatus || "unpaid", refundStatus: b.refundStatus || null,
    canCancel: ["awaiting_payment", "booked", "cancel_requested", "refund_pending", "refund_error", "refund_failed"].includes(b.status),
    checkoutUrl: b.status === "awaiting_payment" && b.holdUntil > now() ? b.checkoutUrl || null : null
  });
  const sessionSummary = session => {
    const draft = draftFromMetadata(session.metadata);
    const status = session.payment_status === "paid" ? "payment_received" : session.status === "expired" ? "expired" : "awaiting_payment";
    return {
      id: draft.q.nonce, totalCents: draft.totalCents,
      label: new Date(draft.arrival * 1000).toLocaleString("en-US", { timeZone: TZ, weekday: "long", month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }),
      service: draft.q.service, status, paymentStatus: session.payment_status === "paid" ? "paid" : "unpaid",
      refundStatus: null, canCancel: session.status === "open", checkoutUrl: session.status === "open" ? session.url || null : null
    };
  };
  async function releaseWithStatus(id, changes) {
    return db.runTransaction(async tx => {
      const ref = bookingRef(id), snap = await tx.get(ref);
      if (!snap.exists) throw fail("Appointment not found.", 404);
      const b = snap.data(), dayRef = store.doc("day_" + b.day), calendar = await tx.get(dayRef);
      tx.update(ref, changes);
      tx.set(dayRef, {
        ...calendar.data(),
        intervals: (calendar.data()?.intervals || []).filter(i => i.id !== id),
        bookingIds: (calendar.data()?.bookingIds || []).filter(v => v !== id)
      });
      return { ...b, ...changes };
    });
  }
  async function startCheckoutStrict(req) {
    if (!stripe || !env.MOBILE_STRIPE_WEBHOOK_SECRET?.startsWith("whsec_")) {
      throw fail("Online payment is not connected yet. Please email us to arrange a visit.", 503);
    }
    const q = unseal(req.body.quoteId), arrival = req.body.arrival;
    if (!Number.isSafeInteger(arrival) || arrival < 0 || arrival > 4102444800) throw fail("Choose an available time.");
    const name = clean(req.body, "name", 100), email = clean(req.body, "email", 200), phone = clean(req.body, "phone", 40, 7), notes = clean(req.body, "notes", 2000, 0);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw fail("Enter a valid email.");
    quoteFresh(q);
    const day = dateAt(arrival), dayRef = store.doc("day_" + day);
    // Read availability only. Do not create an appointment or reserve a slot
    // until Stripe confirms payment.
    const [settings, calendar] = await Promise.all([settingsRef.get(), dayRef.get()]);
    const intervals = (calendar.data()?.intervals || []).filter(i => !i.holdUntil || i.holdUntil > now());
    if (!available(q, day, readSettings(settings), intervals).some(s => s.arrival === arrival)) throw fail("That appointment is no longer available. Choose another time.", 409);
    const metadata = metadataForDraft(q, arrival, name, email, phone, notes);
    const expiresAt = Math.floor(now()) + 35 * 60;
    let session;
    try {
      session = await stripe.checkout.sessions.create({
        mode: "payment", payment_method_types: ["card"], customer_email: email,
        client_reference_id: q.nonce, expires_at: expiresAt,
        line_items: [
          { price_data: { currency: "usd", product_data: { name: q.service === "assembly" ? "Mobile PC assembly — customer-provided parts" : q.service === "both" ? "Mobile PC diagnostic and assembly" : "Mobile PC diagnostic" }, unit_amount: FEES[q.service][0] }, quantity: 1 },
          ...(q.travelCents ? [{ price_data: { currency: "usd", product_data: { name: "Travel — one-way mileage" }, unit_amount: q.travelCents }, quantity: 1 }] : [])
        ],
        metadata,
        payment_intent_data: { metadata },
        success_url: manageUrl(q.nonce, { sessionPlaceholder: true }),
        cancel_url: manageUrl(q.nonce, { canceled: true, sessionPlaceholder: true })
      }, { idempotencyKey: "mobile-checkout-" + q.nonce });
    } catch {
      throw fail("Stripe could not open payment. Please calculate a new estimate and try again.", 503);
    }
    return {
      id: q.nonce,
      manageUrl: manageUrl(q.nonce, { sessionId: session.id }),
      checkoutUrl: session.url || null,
      status: "awaiting_payment", paymentStatus: "unpaid",
      totalCents: q.travelCents + FEES[q.service][0]
    };
  }
  async function startCheckout(req) {
    return startCheckoutStrict(req);
    if (!stripe || !env.MOBILE_STRIPE_WEBHOOK_SECRET?.startsWith("whsec_")) {
      throw fail("Online payment is not connected yet. Please email us to arrange a visit.", 503);
    }
    const q = unseal(req.body.quoteId), arrival = req.body.arrival;
    if (!Number.isSafeInteger(arrival) || arrival < 0 || arrival > 4102444800) throw fail("Choose an available time.");
    const name = clean(req.body, "name", 100), email = clean(req.body, "email", 200), phone = clean(req.body, "phone", 40, 7), notes = clean(req.body, "notes", 2000, 0);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw fail("Enter a valid email.");
    const day = dateAt(arrival), ref = bookingRef(q.nonce), dayRef = store.doc("day_" + day);
    let b = await db.runTransaction(async tx => {
      const old = await tx.get(ref);
      if (old.exists) {
        const existing = old.data();
        if (existing.arrival !== arrival) throw fail("Calculate a new estimate to choose a different appointment.", 409);
        return existing;
      }
      quoteFresh(q);
      const settings = await tx.get(settingsRef), calendar = await tx.get(dayRef);
      const intervals = (calendar.data()?.intervals || []).filter(i => !i.holdUntil || i.holdUntil > now());
      if (!available(q, day, readSettings(settings), intervals).some(s => s.arrival === arrival)) throw fail("That appointment is no longer available. Choose another time.", 409);
      const start = arrival - q.outMinutes * 60, end = arrival + (q.outMinutes + FEES[q.service][1] + q.backMinutes) * 60;
      // Stripe Checkout requires an expiry at least 30 minutes in the future.
      // The extra five minutes gives the server room to retry session creation.
      const holdUntil = Math.floor(now()) + 35 * 60;
      const booking = { id: q.nonce, day, arrival, start, end, name, email, phone, notes, address: q.address,
        service: q.service, miles: q.miles, travelCents: q.travelCents, totalCents: q.travelCents + FEES[q.service][0],
        status: "awaiting_payment", paymentStatus: "unpaid", holdUntil, checkoutCreatedAt: Math.floor(now()), createdAt: now() };
      tx.set(ref, booking);
      tx.set(dayRef, { intervals: [...intervals, { id: q.nonce, start, end, holdUntil }], bookingIds: [...(calendar.data()?.bookingIds || []), q.nonce] });
      return booking;
    });
    if (b.status === "booked" || b.status === "completed") return { id: b.id, manageUrl: manageUrl(b), ...customerSummary(b) };
    if (b.status !== "awaiting_payment" || b.holdUntil <= now()) throw fail("This checkout is closed. Calculate a new estimate.", 409);
    if (b.sessionId) {
      await reconcile(b.id);
      b = (await ref.get()).data();
      return { id: b.id, manageUrl: manageUrl(b), ...customerSummary(b) };
    }
    // Fixed values and an idempotency key make a retry reuse the original Checkout.
    if (b.holdUntil - now() < 30 * 60) throw fail("This payment hold expired. Calculate a new estimate.", 409);
    let session;
    try {
      session = await stripe.checkout.sessions.create({
      mode: "payment", payment_method_types: ["card"], customer_email: b.email,
      client_reference_id: b.id, expires_at: b.holdUntil,
      line_items: [
        { price_data: { currency: "usd", product_data: { name: b.service === "assembly" ? "Mobile PC assembly — customer-provided parts" : b.service === "both" ? "Mobile PC diagnostic and assembly" : "Mobile PC diagnostic" }, unit_amount: FEES[b.service][0] }, quantity: 1 },
        ...(b.travelCents ? [{ price_data: { currency: "usd", product_data: { name: "Travel — one-way mileage" }, unit_amount: b.travelCents }, quantity: 1 }] : [])
      ],
      metadata: { type: "mobile_service", mobileBookingId: b.id },
      payment_intent_data: { metadata: { type: "mobile_service", mobileBookingId: b.id } },
      success_url: manageUrl(b), cancel_url: manageUrl(b, true)
      }, { idempotencyKey: "mobile-checkout-" + b.id });
    } catch (error) {
      await releaseWithStatus(b.id, {
        status: "payment_error",
        paymentStatus: "unpaid",
        paymentErrorAt: now()
      }).catch(() => {});
      throw fail("Stripe could not open payment. Please calculate a new estimate and try again.", 503);
    }
    await db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      if (snap.data().sessionId && snap.data().sessionId !== session.id) throw fail("Checkout conflict.", 409);
      tx.update(ref, { sessionId: session.id, checkoutUrl: session.url || null });
    });
    b = (await ref.get()).data();
    if (["cancel_requested", "canceled"].includes(b.status)) { await cancelBooking(b.id, "system"); b = (await ref.get()).data(); }
    return { id: b.id, manageUrl: manageUrl(b), ...customerSummary(b) };
  }
  async function confirmSessionStrict(sessionId) {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session?.metadata?.type !== "mobile_service") return;
    if (session.payment_status !== "paid") return;
    const draft = draftFromMetadata(session.metadata), id = draft.q.nonce, ref = bookingRef(id);
    const intent = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id;
    if (!intent) throw fail("Payment confirmation is incomplete.", 503);
    if (session.mode !== "payment" || session.currency !== "usd" || session.amount_total !== draft.totalCents) throw fail("Payment does not match this appointment.", 409);
    let needsRefund = false, alreadyCanceled = false;
    await db.runTransaction(async tx => {
      needsRefund = false; alreadyCanceled = false;
      const snap = await tx.get(ref);
      if (snap.exists) {
        const old = snap.data();
        if (["booked", "completed", "refunded"].includes(old.status) && old.paymentStatus === "paid") return;
        if (old.sessionId && old.sessionId !== session.id) throw fail("Payment does not match this appointment.", 409);
        alreadyCanceled = ["cancel_requested", "canceled", "refund_pending", "refund_error", "refund_failed"].includes(old.status);
      }
      const day = dateAt(draft.arrival), dayRef = store.doc("day_" + day);
      const [settingsSnap, calendarSnap] = await Promise.all([tx.get(settingsRef), tx.get(dayRef)]);
      const calendar = calendarSnap.data() || {};
      const intervals = (calendar.intervals || []).filter(i => i.id !== id && (!i.holdUntil || i.holdUntil > now()));
      const start = draft.arrival - draft.q.outMinutes * 60;
      const end = draft.arrival + (draft.q.outMinutes + FEES[draft.q.service][1] + draft.q.backMinutes) * 60;
      // Payment wins the race only if the slot is still available now. The
      // one-hour customer lead time is not applied during confirmation.
      let canBook = false;
      try { canBook = available(draft.q, day, readSettings(settingsSnap), intervals, now(), 0).some(s => s.arrival === draft.arrival); }
      catch { canBook = false; }
      canBook = !alreadyCanceled && canBook;
      needsRefund = !canBook;
      const booking = {
        id, day, arrival: draft.arrival, start, end, name: draft.name, email: draft.email,
        phone: draft.phone, notes: draft.notes, address: draft.q.address, service: draft.q.service,
        miles: draft.q.miles, travelCents: draft.q.travelCents, totalCents: draft.totalCents,
        sessionId: session.id, paymentIntentId: intent, paymentStatus: "paid", paidAt: now(), createdAt: now(),
        status: canBook ? "booked" : "refund_pending", ...(canBook ? {} : { refundStatus: "requested" })
      };
      tx.set(ref, snap.exists ? { ...snap.data(), ...booking } : booking);
      tx.set(dayRef, {
        ...calendar,
        intervals: canBook ? [...intervals, { id, start, end }] : intervals,
        bookingIds: canBook ? [...new Set([...(calendar.bookingIds || []).filter(v => v !== id), id])] : (calendar.bookingIds || []).filter(v => v !== id)
      });
    });
    if (needsRefund) await refundBooking(id);
  }
  async function confirmSession(sessionId) {
    return confirmSessionStrict(sessionId);
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.metadata?.type !== "mobile_service") return;
    const id = validId(session.metadata.mobileBookingId), ref = bookingRef(id);
    if (session.payment_status !== "paid") return;
    const intent = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id;
    if (!intent) throw fail("Payment confirmation is incomplete.", 503);
    let needsRefund = false;
    await db.runTransaction(async tx => {
      needsRefund = false;
      const snap = await tx.get(ref);
      if (!snap.exists) throw fail("Payment has no matching appointment.", 409);
      const b = snap.data();
      if (session.mode !== "payment" || session.currency !== "usd" || session.amount_total !== b.totalCents || (b.sessionId && b.sessionId !== session.id)) throw fail("Payment does not match this appointment.", 409);
      if (["booked", "completed", "refunded"].includes(b.status) && b.paymentStatus === "paid") return;
      const dayRef = store.doc("day_" + b.day), calendar = await tx.get(dayRef);
      const intervals = (calendar.data()?.intervals || []).filter(i => i.id !== id && (!i.holdUntil || i.holdUntil > now()));
      const conflict = intervals.some(i => b.start < i.end && b.end > i.start);
      const canceled = b.status !== "awaiting_payment";
      needsRefund = conflict || canceled;
      tx.update(ref, { sessionId: session.id, paymentIntentId: intent, paymentStatus: "paid", paidAt: now(),
        status: needsRefund ? "refund_pending" : "booked", ...(needsRefund ? { refundStatus: "requested" } : {}) });
      tx.set(dayRef, { ...calendar.data(), intervals: needsRefund ? intervals : [...intervals, { id, start: b.start, end: b.end }] });
    });
    if (needsRefund) await refundBooking(id);
  }
  async function refundState(id, createMissing) {
    let b = (await bookingRef(id).get()).data();
    if (!b?.paymentIntentId) return b;
    const intent = await stripe.paymentIntents.retrieve(b.paymentIntentId, { expand: ["latest_charge"] });
    const charge = intent.latest_charge;
    if (!charge || typeof charge !== "object" || charge.currency !== "usd" || charge.amount !== b.totalCents) throw fail("Payment needs review in Stripe before it can be refunded.", 409);
    const refunds = (await stripe.refunds.list({ charge: charge.id, limit: 100 })).data;
    const active = refunds.filter(r => !["failed", "canceled"].includes(r.status));
    const amount = active.reduce((sum, r) => sum + r.amount, 0);
    let all = active;
    if (amount < b.totalCents && createMissing) {
      const failures = refunds.filter(r => ["failed", "canceled"].includes(r.status)).length;
      const refund = await stripe.refunds.create({ payment_intent: b.paymentIntentId, amount: b.totalCents - amount,
        metadata: { mobileBookingId: id, type: "mobile_service", canceledBy: b.canceledBy || "system" }
      }, { idempotencyKey: `mobile-refund-${id}-${amount}-${failures}` });
      all = [...active, refund];
    }
    const succeeded = all.filter(r => r.status === "succeeded").reduce((sum, r) => sum + r.amount, 0);
    const queued = all.filter(r => !["failed", "canceled"].includes(r.status)).reduce((sum, r) => sum + r.amount, 0);
    const status = succeeded >= b.totalCents ? "refunded" : queued >= b.totalCents ? "refund_pending" : "refund_failed";
    const refundStatus = status === "refunded" ? "succeeded" : status === "refund_pending" ? "pending" : "failed";
    await bookingRef(id).update({ status, refundStatus, refundAmountCents: succeeded, refundIds: all.map(r => r.id) });
    return (await bookingRef(id).get()).data();
  }
  async function refundBooking(id) {
    const b = (await bookingRef(id).get()).data();
    if (!b || !["cancel_requested", "refund_pending", "refund_error", "refund_failed", "refunded"].includes(b.status)) throw fail("Cancel the appointment before requesting a refund.", 409);
    if (b.status === "refunded") return b;
    try { return await refundState(id, true); }
    catch (e) {
      await bookingRef(id).update({ status: "refund_error", refundStatus: "needs_retry" });
      throw fail("Appointment canceled, but the refund could not be submitted. Please retry the refund or contact us.", 503);
    }
  }
  async function cancelBooking(id, canceledBy) {
    let b = await db.runTransaction(async tx => {
      const ref = bookingRef(id), snap = await tx.get(ref);
      if (!snap.exists) throw fail("Appointment not found.", 404);
      const old = snap.data();
      if (old.status === "completed") throw fail("This appointment is already completed.", 409);
      if (["refunded", "canceled"].includes(old.status)) return old;
      const dayRef = store.doc("day_" + old.day), calendar = await tx.get(dayRef);
      const status = ["refund_pending", "refund_error", "refund_failed"].includes(old.status) ? old.status : "cancel_requested";
      tx.update(ref, { status, canceledBy, canceledAt: now() });
      tx.set(dayRef, { ...calendar.data(), intervals: (calendar.data()?.intervals || []).filter(i => i.id !== id) });
      return { ...old, status };
    });
    if (b.status === "refunded" || (b.status === "canceled" && !b.sessionId)) return b;
    if (b.sessionId) {
      let session = await stripe.checkout.sessions.retrieve(b.sessionId);
      if (session.status === "open") {
        try { session = await stripe.checkout.sessions.expire(b.sessionId); }
        catch { session = await stripe.checkout.sessions.retrieve(b.sessionId); if (session.status === "open") throw fail("Cancellation is processing. Please try again.", 503); }
      }
      if (session.payment_status === "paid") await confirmSession(session.id);
      b = (await bookingRef(id).get()).data();
    }
    if (b.paymentIntentId) return refundBooking(id);
    await bookingRef(id).update({ status: "canceled", paymentStatus: "unpaid", refundStatus: "not_required" });
    return (await bookingRef(id).get()).data();
  }
  async function completeBooking(id) {
    return db.runTransaction(async tx => {
      const ref = bookingRef(id), snap = await tx.get(ref);
      if (!snap.exists) throw fail("Appointment not found.", 404);
      const b = snap.data();
      if (b.status === "completed") return;
      if (b.status !== "booked") throw fail("Only a confirmed appointment can be completed.", 409);
      const dayRef = store.doc("day_" + b.day), calendar = await tx.get(dayRef);
      tx.update(ref, { status: "completed", completedAt: now() });
      // Remove it from the active owner list and free the reserved interval.
      // Keep the booking document as a payment/audit record.
      tx.set(dayRef, {
        ...calendar.data(),
        bookingIds: (calendar.data()?.bookingIds || []).filter(v => v !== id),
        intervals: (calendar.data()?.intervals || []).filter(i => i.id !== id)
      });
    });
  }
  async function reconcile(id) {
    const b = (await bookingRef(id).get()).data();
    if (!b) return;
    if (b.status === "cancel_requested") { await cancelBooking(id, b.canceledBy || "system"); return; }
    if (["refund_pending", "refund_failed", "refund_error"].includes(b.status) && b.paymentIntentId) {
      await refundState(id, false); return;
    }
    if (b.status !== "awaiting_payment" || !b.sessionId) return;
    const session = await stripe.checkout.sessions.retrieve(b.sessionId);
    if (session.payment_status === "paid") await confirmSession(session.id);
    else if (session.status === "expired") {
      await db.runTransaction(async tx => {
        const ref = bookingRef(id), snap = await tx.get(ref);
        if (snap.data()?.status !== "awaiting_payment") return;
        const dayRef = store.doc("day_" + b.day), calendar = await tx.get(dayRef);
        tx.update(ref, { status: "expired" });
        tx.set(dayRef, { ...calendar.data(), intervals: (calendar.data()?.intervals || []).filter(i => i.id !== id) });
      });
    }
  }
  async function handlePaymentEvent(event) {
    const object = event.data.object;
    if (event.type.startsWith("checkout.session.") && object.metadata?.type === "mobile_service") {
      if (["checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(event.type)) await confirmSession(object.id);
      if (event.type === "checkout.session.expired") await reconcile(validId(object.metadata.mobileBookingId));
    }
    if (["refund.created", "refund.updated", "refund.failed"].includes(event.type) && object.metadata?.type === "mobile_service") {
      await refundState(validId(object.metadata.mobileBookingId), false);
    }
    return { received: true };
  }

  const handlers = {
    quote: async req => {
      limit(req); key();
      const address = clean(req.body, "address", 300, 12), service = req.body.service;
      if (!Object.hasOwn(FEES, service)) throw fail("Choose a service.");
      const [out, back] = await Promise.all([route(env.MOBILE_ORIGIN_ADDRESS, address), route(address, env.MOBILE_ORIGIN_ADDRESS)]);
      const miles = Math.round(out.meters / 1609.344 * 100) / 100;
      if (miles > Number(env.MOBILE_MAX_MILES || 100)) throw fail("This address is outside online booking range. Please email us to discuss a visit.");
      const travelCents = Math.round(miles * 50), [serviceCents, serviceMinutes] = FEES[service];
      const q = { nonce: crypto.randomBytes(16).toString("hex"), address, service, miles, travelCents, outMinutes: out.minutes, backMinutes: back.minutes, expires: now() + 1800 };
      return { id: seal(q), miles, travelCents, serviceCents, totalCents: travelCents + serviceCents };
    },
    slots: async req => {
      limit(req); const q = unseal(req.body.quoteId); quoteFresh(q);
      const day = validDate(req.body.date);
      const [settings, calendar] = await Promise.all([settingsRef.get(), store.doc("day_" + day).get()]);
      return { slots: available(q, day, readSettings(settings), calendar.data()?.intervals || []), message: "No times available. Choose another day or email us to arrange your visit." };
    },
    book: async req => {
      limit(req);
      return startCheckout(req);
    },
    status: async req => {
      limit(req);
      const access = await authorizeCustomer(req);
      if (access.booking) {
        await reconcile(access.id);
        return customerSummary((await bookingRef(access.id).get()).data());
      }
      // The first status request after Stripe redirects can finish the
      // confirmation synchronously, so the customer does not wait for polling.
      if (access.session.payment_status === "paid") {
        await confirmSession(access.session.id);
        const saved = await bookingRef(access.id).get();
        if (saved.exists) return customerSummary(saved.data());
      }
      return sessionSummary(access.session);
    },
    cancel: async req => {
      limit(req);
      const access = await authorizeCustomer(req);
      if (access.booking) {
        await cancelBooking(access.id, "customer");
        return customerSummary((await bookingRef(access.id).get()).data());
      }
      let session = access.session;
      if (session.status === "open") {
        try { session = await stripe.checkout.sessions.expire(session.id); }
        catch {
          session = await stripe.checkout.sessions.retrieve(session.id);
          if (session.status === "open") throw fail("Cancellation is processing. Please try again.", 503);
        }
      }
      if (session.payment_status === "paid") {
        await confirmSession(session.id);
        const saved = await bookingRef(access.id).get();
        if (saved.exists) {
          if (saved.data().status === "booked") await cancelBooking(access.id, "customer");
          return customerSummary((await bookingRef(access.id).get()).data());
        }
      }
      return sessionSummary(session);
    },
    admin: async req => {
      await authorize(req);
      if (req.body.settings) {
        const settings = checkSettings(req.body.settings);
        const hours = Object.fromEntries(
          Object.entries(settings.hours).map(([day, ranges]) => [
            day,
            ranges.map(([start, end]) => ({ start, end }))
          ])
        );
        await settingsRef.set({ hours, closedDates: settings.closedDates });
      }
      if (req.body.cancel) await cancelBooking(validId(req.body.cancel), "owner");
      if (req.body.complete) await completeBooking(validId(req.body.complete));
      if (req.body.retryRefund) await refundBooking(validId(req.body.retryRefund));
      const day = validDate(req.body.date || dateAt(now()));
      const [settings, calendar] = await Promise.all([settingsRef.get(), store.doc("day_" + day).get()]);
      const ids = calendar.data()?.bookingIds || [];
      // Refresh payment/refund states, including when the customer did not return from Stripe.
      await Promise.all(ids.map(id => reconcile(id).catch(() => {})));
      const snapshots = await Promise.all(ids.map(id => store.doc("booking_" + id).get()));
      return { settings: readSettings(settings), date: day, bookings: snapshots.filter(s => s.exists).map(s => s.data()).filter(b => b.status !== "completed" && !(b.status === "awaiting_payment" && b.holdUntil <= now())).sort((a, b) => a.arrival - b.arrival) };
    }
  };
  for (const [name, handler] of Object.entries(handlers)) app.post("/api/mobile/" + name, wrap(handler));
  return { ...handlers, webhook: handlePaymentEvent };
}

mobilePayments = register({ app, db, admin, stripe });
})();

/* ================= START SERVER ================= */
const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
