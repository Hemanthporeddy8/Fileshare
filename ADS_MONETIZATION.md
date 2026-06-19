# Express Permanent Share Mode: Ad Monetization Guide

This guide details the ad placements, code implementation steps, and revenue projections for monetizing your **Express Permanent Share** web application.

---

## 1. Ad Placements & Code Snippets

To show Google AdSense ads, you will need to add the following code blocks to [public/index.html](file:///d:/D%20folder%20downloads/c%20files/fileshare/public/index.html).

### A. Load AdSense Library
Place this script inside the `<head>` tag of your HTML to load the Google AdSense scripts:
```html
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-YOUR_PUBLISHER_ID" crossorigin="anonymous"></script>
```

---

### B. Place 300x250 Banner Ad on Mobile (Sender Progress Screen)
* **Location**: Below the progress bar on the sender screen when uploading files.
* **AdSense Code**:
```html
<!-- Inside the mobile upload screen HTML in public/index.html -->
<div style="margin-top: 1rem; text-align: center;">
  <ins class="adsbygoogle"
       style="display:inline-block;width:300px;height:250px"
       data-ad-client="ca-pub-YOUR_PUBLISHER_ID"
       data-ad-slot="SENDER_BANNER_SLOT_ID"></ins>
  <script>
    (adsbygoogle = window.adsbygoogle || []).push({});
  </script>
</div>
```

---

### C. Place 728x90 Banner Ad on PC (Receiver Dashboard Header)
* **Location**: Inside the dashboard card, directly above the "Received Files" header.
* **AdSense Code**:
```html
<!-- Inside the showInboxDashboard HTML -->
<div style="margin: 1rem 0; text-align: center;">
  <ins class="adsbygoogle"
       style="display:inline-block;width:728px;height:90px"
       data-ad-client="ca-pub-YOUR_PUBLISHER_ID"
       data-ad-slot="DASHBOARD_HEADER_SLOT_ID"></ins>
  <script>
    (adsbygoogle = window.adsbygoogle || []).push({});
  </script>
</div>
```

---

### D. Place 300x600 Vertical Ad on PC (Receiver Dashboard Sidebar)
* **Location**: On the left or right side of the main container on the PC dashboard view.
* **AdSense Code**:
```html
<ins class="adsbygoogle"
     style="display:inline-block;width:300px;height:600px"
     data-ad-client="ca-pub-YOUR_PUBLISHER_ID"
     data-ad-slot="DASHBOARD_SIDEBAR_SLOT_ID"></ins>
<script>
  (adsbygoogle = window.adsbygoogle || []).push({});
</script>
```

---

### E. Auto-Refreshing Dashboard Ads (For Passive Income)
Since the shop owner keeps the tab open for 8–10 hours, you should automatically refresh the dashboard ads every 60 seconds to increase views.
* **Script snippet to add to your JS**:
```javascript
// Add this helper to refresh ads on the dashboard every 60 seconds
setInterval(() => {
  if (getActiveSessionType()?.type === 'inbox') {
    const ads = document.querySelectorAll('.adsbygoogle');
    ads.forEach(ad => {
      try {
        (adsbygoogle = window.adsbygoogle || []).push({});
      } catch (e) {
        console.warn('AdSense refresh ignored or blocked', e);
      }
    });
  }
}, 60000); // 60,000 milliseconds = 1 minute
```

---

### F. Add Sponsor Banner to the Printed A4 Wall Flyer
* **Location**: Inside the `printQRFlyer(code)` function in [public/index.html](file:///d:/D%20folder%20downloads/c%20files/fileshare/public/index.html).
* **HTML replacement**:
```html
<!-- Add a sponsorship strip at the bottom of the printed container -->
<div class="instructions" style="margin-top: 1.5rem; text-align: center; border-top: 1px dashed #ccc; padding-top: 1rem; display: flex; align-items: center; justify-content: space-around;">
  <div>
    <div style="font-size: 0.75rem; color: #777788; text-transform: uppercase;">Sponsored By</div>
    <div style="font-size: 1.1rem; font-weight: bold; color: #0d0d1a;">CLASSMATE STATIONARY</div>
  </div>
  <div style="font-size: 0.75rem; color: #333344; max-width: 250px;">
    Scan the secondary QR code at the counter to get 10% off on all school supplies!
  </div>
</div>
```

---

## 2. Enforcing "Premium" Ad-Free Mode
If a shopowner buys the **Premium Subscription** ($5/month or ₹399/month), we must hide the ads. 
* Add a simple `if` condition when rendering the dashboard HTML:
```javascript
// Inside showInboxDashboard(code, token)
const isPremiumUser = checkPremiumStatusFromToken(token); // check if isPremium field is true in JWT payload

if (!isPremiumUser) {
  // Render the AdSense <ins> tags inside the innerHTML
} else {
  // Render a clean layout without ads
}
```

---

## 3. Financial Projections Reference (1 USD = ₹83)

### 🇮🇳 Stage 1: Local Growth (100 Active Shops)
* *Assumes: Each shop gets 50 customer transfers per day.*
* **Dashboard Ads**: **₹7,470 / day** ($90)
* **Sender Ads**: **₹1,660 / day** ($20)
* **Flyer Sponsorship**: **₹548 / day** ($6.60 / day) (₹16,600 / month)
* **Premium Subscriptions**: **₹66 / day** ($0.80 / day) (₹2,075 / month)
* 💰 **Total Daily Earnings**: **~₹9,711 / day** ($117)
* 💰 **Total Monthly Earnings**: **~₹2,90,500 / month** ($3,500)

### 🇮🇳 Stage 2: Scale-Up / City-Wide (1,000 Active Shops)
* *Assumes: Each shop gets 60 customer transfers per day.*
* **Dashboard Ads**: **₹74,700 / day** ($900)
* **Sender Ads**: **₹19,920 / day** ($240)
* **Flyer Sponsorship**: **₹5,478 / day** ($66.00 / day) (₹1,66,000 / month)
* **Premium Subscriptions**: **₹689 / day** ($8.30 / day) (₹20,750 / month)
* 💰 **Total Daily Earnings**: **~₹1,00,762 / day** ($1,214)
* 💰 **Total Monthly Earnings**: **~₹30,21,200 / month** ($36,400)

### 🇮🇳 Stage 3: Highly Famous / Nationwide (5,000 Active Shops)
* *Assumes: Each shop gets 70 customer transfers per day.*
* **Dashboard Ads**: **₹3,73,500 / day** ($4,500)
* **Sender Ads**: **₹1,16,200 / day** ($1,400)
* **Flyer Sponsorship**: **₹27,639 / day** ($333.00 / day) (₹8,30,000 / month)
* **Premium Subscriptions**: **₹3,453 / day** ($41.60 / day) (₹1,03,750 / month)
* 💰 **Total Daily Earnings**: **~₹5,20,742 / day** ($6,274)
* 💰 **Total Monthly Earnings**: **~₹1,56,20,600 / month** ($188,200)
