'use strict';
const path = require('path');
const { getDb } = require(path.join(__dirname, '../src/db'));

const OFFERS = [
`🛒 *AMAZON PRIME MEMBERSHIP – 1 MONTH*

🔐 *Private Account (ID + Password)*
Perfect for *Amazon Shopping* — enjoy Summer Sale benefits 🔥

😅 *MRP:* ₹299/month
➡️ *OFFER PRICE:* ₹70/month

━━━━━━━━━━━━━━━

🔥 *BENEFITS:*
💠 FREE 1-Day Delivery 🚚
💠 Prime Early Access ⏳
💠 Prime Exclusive Deals 💸
💠 Prime Video 🎬
💠 Prime Music 🎵
💠 Prime Reading 📚

━━━━━━━━━━━━━━━

⚡ *Limited Offer – Grab Fast!*
📩 *DM to Order Now*

*Buy Other Products : ott24x7.com (Costumer)*
*Create Your Store : store.watshop.in (Seller)*

*Buy Instagram Followers : smm.ott24x7.com (Costumer)*
*Create Your SMM Panel : smm.watshop.in (Seller)*`,

`🎨 *Adobe Creative Cloud – 3 Months*

🔐 Official License | Personal Plan
📧 Account with Mail Access (Outlook)

✨ *Includes:*
* 20+ Adobe Apps (Photoshop, Premiere Pro, Illustrator & more)
* 🚀 Firefly AI + 10,000 AI Credits/month
* ☁️ 85GB Cloud Storage
* 📱💻 Works on 2 Devices (All Platforms)
* 🏢 Commercial Use Supported

❌ *Retail:* ₹5,999
✅ *Offer Price:* ₹999

⏰ *Limited-Time Deal*
📩 *DM to Order*

*Buy Other Products : ott24x7.com (Costumer)*
_Create Your Store : store.watshop.in (Seller)_

*Buy Instagram Followers : smm.ott24x7.com (Costumer)*
_Create Your SMM Panel : smm.watshop.in (Seller)_`,

`📺 *ZEE5 Premium HD – 1 Year*

🔥 *Limited-Time Offer*

💰 *Only ₹399*
❌ MRP ~₹999~

✨ *Includes:*
• HD 1080p Streaming
• 12 Months Access
• 2 Devices (With Ads)
• Activation on Your Own Number

🎬 Movies, Web Series & Originals
⚡ Instant Activation

📩 *DM to Activate Now*

*Buy Other Products : ott24x7.com (Costumer)*
_Create Your Store : store.watshop.in (Seller)_

*Buy Instagram Followers : smm.ott24x7.com (Costumer)*
_Create Your SMM Panel : smm.watshop.in (Seller)_`,

`✨ *PRIME VIDEO – ADS FREE (6 MONTHS)*

💎 *Only ₹249*
🚫 Enjoy *Ad-Free Streaming*

━━━━━━━━━━━━━━━

📺 *Account Details:*
✅ Private Account (ID + Password)
✅ Mail Access Provided
✅ Use on 3 Devices (1 TV + 2 Others)

━━━━━━━━━━━━━━━

🎬 *What You Get:*
• No Ads Experience
• HD & 4K Quality
• Unlimited Movies & Series
• Smooth Multi-Device Access

━━━━━━━━━━━━━━━

📌 *Important:*
• Only for *Prime Video Watching*
• ❌ No Shopping or Other Prime Benefits

━━━━━━━━━━━━━━━

⚡ Instant Delivery
🔥 Limited Offer

📩 *DM to Order Now*

*Buy Other Products : ott24x7.com (Costumer)*
_Create Your Store : store.watshop.in (Seller)_

*Buy Instagram Followers : smm.ott24x7.com (Costumer)*
_Create Your SMM Panel : smm.watshop.in (Seller)_`,

`✨ *QuillBot Premium – 6 Months*

🔐 Shared Account (1 Device)
💰 *Price:* ₹399

━━━━━━━━━━━━━━━

📧 Login Details Provided (Email + Password)

✨ *Features:*
• Unlimited Paraphrasing
• Grammar Checker
• Summarizer & Rewriter
• Faster & Advanced Modes

━━━━━━━━━━━━━━━

⚡ Easy Access | Limited Stock

📩 *DM to Buy Now*

*Buy Other Products : ott24x7.com (Costumer)*
_Create Your Store : store.watshop.in (Seller)_

*Buy Instagram Followers : smm.ott24x7.com (Costumer)*
_Create Your SMM Panel : smm.watshop.in (Seller)_`,

`🎬 *SONYLIV Premium HD Plan*

❌ *MRP:* ₹1499/year

━━━━━━━━━━━━━━━

💥 *Best Offer Prices:*
✅ 6 Months – ₹250
✅ 12 Months – ₹450
✅ 24 Months – ₹750

━━━━━━━━━━━━━━━

📱 2 Devices | 5 Profiles
🎟️ Redeem Code
📞 Activation on Your Mobile Number

✨ *Features:*
• Full HD 1080p Streaming
• Live Sports & Tournaments
• Movies, Originals & Regional Content
• Works on All Devices
• Offline Download Support

━━━━━━━━━━━━━━━

⚡ Instant Activation
🔥 Limited Slots

📩 *DM to Activate Now*

*Buy Other Products : ott24x7.com (Costumer)*
_Create Your Store : store.watshop.in (Seller)_

*Buy Instagram Followers : smm.ott24x7.com (Costumer)*
_Create Your SMM Panel : smm.watshop.in (Seller)_`,

`🎨 *PicsArt Pro – 1 Year*

💰 *Offer Price:* ₹550
🎟️ Redeem Code | Activate on Your Own Account

━━━━━━━━━━━━━━━

✨ *Features:*
• Unlimited Premium Templates
• AI Tools (BG Remover, Enhance, etc.)
• Pro Stickers & Fonts
• Advanced Photo & Video Editing
• No Watermark

📱 Works on Android, iOS & Web

━━━━━━━━━━━━━━━

⚡ Instant Delivery | Limited Offer

📩 *DM to Activate Now*

*Buy Other Products : ott24x7.com (Costumer)*
_Create Your Store : store.watshop.in (Seller)_

*Buy Instagram Followers : smm.ott24x7.com (Costumer)*
_Create Your SMM Panel : smm.watshop.in (Seller)_`,

`💼 *LinkedIn Premium – Career Plan*

⏳ *3 Months Trial Offer*
💰 *Only ₹299*

🔗 Activated via Redeem Link
👤 Works on Your Existing LinkedIn Account

━━━━━━━━━━━━━━━

🚀 *Features:*
• See Who Viewed Your Profile
• InMail Credits (Message Recruiters)
• Unlimited Profile Views
• Job Insights & Salary Data
• Applicant Comparison
• LinkedIn Learning Access

━━━━━━━━━━━━━━━

⚡ *Activation Steps:*

1. Open the redeem link
2. Login to your LinkedIn account
3. Click *Activate Offer*
4. Proceed to checkout

━━━━━━━━━━━━━━━

💳 *Important:*
• Add Card or UPI for activation
• ₹1080 mandate may show (for verification)
• Only ₹2 will be charged now

⚠️ *Note:*
• Cancel auto-pay before trial ends to avoid full charge

━━━━━━━━━━━━━━━

⚡ Instant Activation | Limited Slots

📩 *DM to Activate Now*

*Buy Other Products : ott24x7.com (Costumer)*
_Create Your Store : store.watshop.in (Seller)_

*Buy Instagram Followers : smm.ott24x7.com (Costumer)*
_Create Your SMM Panel : smm.watshop.in (Seller)_`,

`🎨 *Beautiful.ai Pro EDU – 1 Year*

💰 *Price:* ₹499

🔐 Login Details Provided (ID + Password)
🎓 EDU Plan (Student Version)

━━━━━━━━━━━━━━━

✨ *EDU Features:*
• AI-Powered Presentation Maker
• Smart Templates & Auto Design
• Professional Slides in Minutes
• Charts, Animations & Visual Tools
• Easy Editing & Export Options

━━━━━━━━━━━━━━━

📌 *Note:*
• EDU Plan (Not Official Professional Plan)
• 1 Year Warranty Included

━━━━━━━━━━━━━━━

⚡ Instant Delivery | Limited Offer

📩 *DM to Order Now*

*Buy Other Products : ott24x7.com (Costumer)*
_Create Your Store : store.watshop.in (Seller)_

*Buy Instagram Followers : smm.ott24x7.com (Costumer)*
_Create Your SMM Panel : smm.watshop.in (Seller)_`,

`🎨 *NoteGPT Pro EDU – 1 Month*

💰 *Price:* ₹49

🔐 Login Details Provided (ID + Password)
🎓 EDU Plan (Student Version)

━━━━━━━━━━━━━━━

✨ *Features:*
• AI Notes & Summarization
• Smart Study & Research Tools
• Content Writing Assistance
• Fast & Easy Note Generation

━━━━━━━━━━━━━━━

📌 *Note:*
• EDU Plan (Student Version)
• Best for Learning & Productivity

━━━━━━━━━━━━━━━

⚡ Instant Delivery | Limited Offer

📩 *DM to Order Now*

*Buy Other Products : ott24x7.com (Costumer)*
_Create Your Store : store.watshop.in (Seller)_

*Buy Instagram Followers : smm.ott24x7.com (Costumer)*
_Create Your SMM Panel : smm.watshop.in (Seller)_`,

`🎨 *iAsk AI Pro EDU – 1 Year*

💰 *Price:* ₹499

🔐 Login Details Provided (ID + Password)
🎓 EDU Plan (Student Version)

━━━━━━━━━━━━━━━

✨ *Features:*
• AI-Powered Answers & Research
• Fast Search with Accurate Results
• Study & Homework Assistance
• Smart Writing & Explanation Tools

━━━━━━━━━━━━━━━

📌 *Note:*
• EDU Plan (Student Version)
• Best for Students & Daily Use

━━━━━━━━━━━━━━━

⚡ Instant Delivery | Limited Offer

📩 *DM to Order Now*

*Buy Other Products : ott24x7.com (Costumer)*
_Create Your Store : store.watshop.in (Seller)_

*Buy Instagram Followers : smm.ott24x7.com (Costumer)*
_Create Your SMM Panel : smm.watshop.in (Seller)_`,

`🌟 *InVideo Unlimited Studio Plan – 1 Year*

🚫 *Not AI Plan* (Studio Plan Only)

💰 *Price:* ₹1299

🔐 Private Account on Your Email

━━━━━━━━━━━━━━━

✨ *Plan Details:*
• Unlimited Video Editing Access
• Premium Features (Non-AI)
• Works on Your Own Account
• Renewable Next Year

━━━━━━━━━━━━━━━

✅ *Why Choose This:*
• Low Cost
• 100% Private Account
• Genuine Access
• Same Price Renewal

━━━━━━━━━━━━━━━

🚫 *Not AI Plan* (Studio Plan Only)


🚫 *Important Rules:*
• Don't connect social media accounts
• Don't change team settings/presets
• Don't upload logo in team presets
• iStock clips not included

⚠️ Rule violation = access removal without warning

━━━━━━━━━━━━━━━

🛒 *DM to Order Now*

*Buy Other Products : ott24x7.com (Costumer)*
_Create Your Store : store.watshop.in (Seller)_

*Buy Instagram Followers : smm.ott24x7.com (Costumer)*
_Create Your SMM Panel : smm.watshop.in (Seller)_`,

`🚀 *Google Drive 100GB – 6 Months*

💰 *Price:* ₹299

🎟️ Activated via Voucher Code
🔓 Works on Existing Google Accounts

━━━━━━━━━━━━━━━

✨ *Features:*
• 100GB Cloud Storage
• Works with Drive, Gmail & Photos
• Store Photos, Videos & Files
• Secure & Reliable Storage
• Easy Redemption

━━━━━━━━━━━━━━━

⚡ Instant Delivery | Limited Stock

📩 *DM to Buy Now*

*Buy Other Products : ott24x7.com (Costumer)*
_Create Your Store : store.watshop.in (Seller)_

*Buy Instagram Followers : smm.ott24x7.com (Costumer)*
_Create Your SMM Panel : smm.watshop.in (Seller)_`,

`🔐 *NordVPN Voucher Plan*

🌍 Secure & Private Internet Access

🎟️ Redeem Code Activation
📧 Use on Your Own Email
📱 Works on up to 10 Devices

━━━━━━━━━━━━━━━

⏳ *Plans & Pricing:*
👉 3 Months – ₹499
👉 6 Months – ₹899

━━━━━━━━━━━━━━━

🚀 *Features:*
• High-Speed Global Servers
• No-Logs Policy (Privacy Protected)
• Works on Wi-Fi, Mobile & PC
• Hide IP Address
• Bypass Geo Restrictions
• Supports Android, iOS, Windows & Mac

━━━━━━━━━━━━━━━

⚡ Instant Delivery | Easy Setup

📩 *DM to Activate Now*

*Buy Other Products : ott24x7.com (Costumer)*
_Create Your Store : store.watshop.in (Seller)_

*Buy Instagram Followers : smm.ott24x7.com (Costumer)*
_Create Your SMM Panel : smm.watshop.in (Seller)_`,

`🎨 *CANVA EDU PRO – SPECIAL OFFER*

Upgrade your design game with *Canva Education Pro* 🚀
Perfect for creators, marketers, students & resellers

━━━━━━━━━━━━━━━

👨‍🎓 *Canva Edu Pro (Student Access)*
📩 Invite on Your Email
⏳ Long-Term Access

💰 *Price:* ₹199

✔️ Access to most Canva Pro features
✔️ Best for personal design use
❌ Brand Kit not included
🛡️ 1 Year Warranty

━━━━━━━━━━━━━━━

🏫 *Canva Edu Pro (Staff Access)*
📩 Invite on Your Email
👥 Add up to 10 Team Members

💰 *Price:* ₹499

✔️ Access to most Canva Pro features
✔️ Brand Kit available
🛡️ 1 Year Warranty

━━━━━━━━━━━━━━━

🎁 *BONUS:*
📂 80,000+ Premium Canva Templates
🔗 Google Drive Download Included

Perfect for:
• Instagram Posts & Reels Covers
• Business & Marketing Designs

━━━━━━━━━━━━━━━

⚡ Instant Activation
🛡️ Trusted Supplier

📩 *DM to Order Now*

*Buy Other Products : ott24x7.com (Costumer)*
_Create Your Store : store.watshop.in (Seller)_

*Buy Instagram Followers : smm.ott24x7.com (Costumer)*
_Create Your SMM Panel : smm.watshop.in (Seller)_`,

`🎧 *Apple Music Plus – 6 Months*

💰 *Only ₹299*

🎟️ Redeem Code Activation
👤 Works on Your Apple ID

━━━━━━━━━━━━━━━

🚀 *Features:*
• Ad-Free Music
• Unlimited Downloads
• Lossless & High-Quality Audio
• Offline Listening
• Millions of Songs & Playlists

📱 Works on iPhone, iPad, Mac, Android & Web

━━━━━━━━━━━━━━━

⚡ Instant Activation | Limited Offer

📩 *DM to Activate Now*

*Buy Other Products : ott24x7.com (Costumer)*
_Create Your Store : store.watshop.in (Seller)_

*Buy Instagram Followers : smm.ott24x7.com (Costumer)*
_Create Your SMM Panel : smm.watshop.in (Seller)_`,

`🎬 *Apple TV+ Subscription Voucher*

💰 *Special Discount Offer*

━━━━━━━━━━━━━━━

📦 *Plans & Pricing:*
• 6 Months – ₹399
• 1 Year – ₹550

🔥 *Flat 70% OFF – Limited Time*

━━━━━━━━━━━━━━━

📺 *Features:*
• Watch Apple Original Movies & Shows
• 100% Ad-Free Streaming
• Access Anytime, Anywhere

📱 Works on iPhone, iPad, Mac & Apple TV

━━━━━━━━━━━━━━━

🌎 *Availability:*
🇮🇳 Works on Indian Apple IDs

━━━━━━━━━━━━━━━

⚡ Instant Activation

📩 *DM to Order Now*

*Buy Other Products : ott24x7.com (Costumer)*
_Create Your Store : store.watshop.in (Seller)_

*Buy Instagram Followers : smm.ott24x7.com (Costumer)*
_Create Your SMM Panel : smm.watshop.in (Seller)_`,

`🎓 *Coursera Org Plan – Premium Learning Access* 🚀

📧 Activated on Your Own Email
🏅 Certificates on Your Name
📚 Access to Almost All Courses

━━━━━━━━━━━━━━━

💰 *Plans & Pricing:*
✅ 3 Months – ₹700
✅ 6 Months – ₹1500
✅ 1 Year – ₹2400

━━━━━━━━━━━━━━━

💼 *Best For:*
Students | Job Seekers | Professionals | Skill Upgrade

━━━━━━━━━━━━━━━

⚠️ *Important Note:*
This is a *3rd-Party Sponsored Coursera Plus Organizational Plan* — not an official individual Coursera Plus subscription.

Validity may not show fixed expiry and access may continue longer depending on organization access.

━━━━━━━━━━━━━━━

⚡ Instant Activation

📩 *DM to Activate Now*

*Buy Other Products : ott24x7.com (Costumer)*
_Create Your Store : store.watshop.in (Seller)_

*Buy Instagram Followers : smm.ott24x7.com (Costumer)*
_Create Your SMM Panel : smm.watshop.in (Seller)_`,

`🌐 *Office 2024 Offers*

Get genuine Office activation for your PC/Mac with warranty included ✅

━━━━━━━━━━━━━━━

💼 *Office 2024 Pro Plus LTSC*
🖥️ *For:* 1 PC
🔑 *Type:* PH Key
💰 *Offer Cost:* $12 / ₹999
✅ Warranty Included

📌 *Features:*
• Word, Excel, PowerPoint, Outlook
• One-time activation
• Best for Windows PC
• Suitable for office, business & personal work

━━━━━━━━━━━━━━━

💼 *Office 2024 Home & Business*
🖥️ *For:* 1 PC / Mac
🔗 *Type:* BIND License
💰 *Offer Cost:* $59.80 / ₹5499
✅ Warranty Included

📌 *Features:*
• Word, Excel, PowerPoint, Outlook
• Binds with account/device as per activation process
• Supports PC & Mac
• Best for business, professional & daily use

━━━━━━━━━━━━━━━

⚡ Limited Stock Available
📩 *DM / WhatsApp to Order Now*

*Buy Other Products : ott24x7.com (Costumer)*
_Create Your Store : store.watshop.in (Seller)_

*Buy Instagram Followers : smm.ott24x7.com (Costumer)*
_Create Your SMM Panel : smm.watshop.in (Seller)_`,

`🌐 *MS Office 2021 License Offers*

Premium Office activation available for PC & Mac ✅

━━━━━━━━━━━━━━━

💼 *Office 2021 Home & Business*
🍎 *For:* 1 Mac
🔗 *Type:* BIND License
💰 *Price:* $14.50 / Rs.1399

📌 *Features:*
✅ Word, Excel, PowerPoint
✅ Outlook Included
✅ Best for Mac users
✅ One-time activation

━━━━━━━━━━━━━━━

💼 *Office 2021 Pro Plus*
🖥️ *For:* 1 PC
🔗 *Type:* BIND License
💰 *Price:* $25.50 / Rs.2499

📌 *Features:*
✅ Word, Excel, PowerPoint
✅ Outlook, Access & Publisher
✅ Best for business & office work
✅ One-time activation

━━━━━━━━━━━━━━━

💼 *Office 2021 Pro Plus*
🖥️ *For:* 5 PC
🌐 *Type:* Retail Online
💰 *Price:* $15.40/ Rs.1499

📌 *Features:*
✅ Activate on up to 5 PCs
✅ Word, Excel, PowerPoint
✅ Outlook, Access & Publisher
✅ Online retail activation

━━━━━━━━━━━━━━━

💼 *Office 2021 Pro Plus*
🖥️ *For:* 1 PC
📞 *Type:* Activate by Phone
💰 *Price:* $2.70/ Rs.299

📌 *Features:*
✅ Budget Office activation
✅ Word, Excel, PowerPoint
✅ Outlook, Access & Publisher
✅ Phone activation process

━━━━━━━━━━━━━━━

💼 *Office 2021 Home & Student*
🖥️ *For:* 1 PC
🔗 *Type:* BIND License
💰 *Price:* $15.50 / Rs.1499

📌 *Features:*
✅ Word, Excel, PowerPoint
✅ Best for students & personal use
✅ Simple one-time activation
❌ Outlook not included

━━━━━━━━━━━━━━━

⚡ Limited Stock Available
📩 *DM / WhatsApp to Order Now*

*Buy Other Products : ott24x7.com (Costumer)*
_Create Your Store : store.watshop.in (Seller)_

*Buy Instagram Followers : smm.ott24x7.com (Costumer)*
_Create Your SMM Panel : smm.watshop.in (Seller)_`,

`🔥 GEMINI AI PRO VEO3 +  1TB    STORAGE 🔥
🅰️
Get powerful AI tools with huge cloud storage in one plan 🚀

💰OFFER Price - 700 rs With Warranty

✅ 12 Month Invite From Fam
✅ Instant Activation
✅ 1000 AI Credits Every Month
✅ 1TB Cloud Storage Included
✅ Family Sharing 1 Invite

🎯 Best for:
* Creators
* Developers
* Students
* Professionals

💰OFFER Price - 700 rs With Warranty

⚡️ Instant Setup
🔐 Secure Access
📩 DM Now for Price

*Buy Other Products : ott24x7.com (Costumer)*
_Create Your Store : store.watshop.in (Seller)_

*Buy Instagram Followers : smm.ott24x7.com (Costumer)*
_Create Your SMM Panel : smm.watshop.in (Seller)_`,

`*🎬 CAPCUT PRO PLAN 🎬*

*✨ 6 Months Premium Access*
*💰 Offer Price – ₹1800* (limited time)

*📧 Activated on Your New Email ID*
🎟️ Direct Premium Access

*🚀 Pro Features Included:*
✅ All Pro Templates & Effects
✅ No Watermark on Videos
✅ Premium Transitions, Filters & Fonts
✅ 4K / HD Export Support
✅ Advanced Video Editing Tools
*✅ Works on Mobile & PC*

*⚡ Instant Activation | Limited-Time Offer*

📩 DM / WhatsApp to Buy Now

*Buy Other Products : ott24x7.com (Costumer)*
_Create Your Store : store.watshop.in (Seller)_

*Buy Instagram Followers : smm.ott24x7.com (Costumer)*
_Create Your SMM Panel : smm.watshop.in (Seller)_`,

`🔥 *GEMINI AI PRO VEO3 +   5TB    STORAGE* 🔥
🅰️
Get powerful AI tools with huge cloud storage in one plan 🚀

💰OFFER Price - 2200 rs With Warranty

✅ 18 Month Voucher
✅ Redeem Key Activation
✅ 1000 AI Credits Every Month
✅ 5TB Cloud Storage Included
✅ Family Sharing Supported

🎯 Best for:
* Creators
* Developers
* Students
* Professionals

💰OFFER Price - *2200 rs With Warranty*

⚡️ *Instant Setup*
🔐 Secure Access

*Buy Other Products : ott24x7.com (Costumer)*
_Create Your Store : store.watshop.in (Seller)_

*Buy Instagram Followers : smm.ott24x7.com (Costumer)*
_Create Your SMM Panel : smm.watshop.in (Seller)_`,

`*Notion Plus 1 Year Plan for Education* 📚

* *Unlimited Pages and Blocks*: 📝 Students can upload unlimited blocks and files to their workspace.

*~😅 MRP - ₹12,000~*

*➡️ MY PRICE -  ₹499/1 year- ✅*

🔹 *Validity:* 1 Year Full
🔹 *Working Worldwide*✅

*🛄Payment Mode 🛄*

*UPI , Paytm , PhonePe, Gpay (All Indian UPI)*

*✅Crypto - USDT on Chain or Binance*

*✅Credit Card Debit Card (2.5% Extra)*

*Buy Other Products : ott24x7.com (Costumer)*
_Create Your Store : store.watshop.in (Seller)_

*Buy Instagram Followers : smm.ott24x7.com (Costumer)*
_Create Your SMM Panel : smm.watshop.in (Seller)_`,

`🎨 *Adobe Acrobat Pro DC 2022 – Lifetime License (PC)* 🔥

💻 Get *Adobe Acrobat Pro DC 2022* with
✅ Serial Key
✅ Download Link
✅ Instant Delivery ⚡

💰 *Price: ₹1499 Only*

━━━━━━━━━━━━━━━

📌 *Features Included:*

✔️ Create, Edit & Convert PDF Files
✔️ PDF to Word / Excel / PowerPoint
✔️ Add Signatures & Password Protection 🔐
✔️ Merge, Organize & Manage Pages
✔️ Create & Edit Fillable Forms

━━━━━━━━━━━━━━━

📦 *What You Will Receive:*

✅ Serial Number
✅ Download Link
✅ Lifetime Access (One-Time Payment)
✅ Works Worldwide 🌍
✅ Windows PC Supported Only

⚠️ *Note:*
This is an older version and *cannot be redeemed on Adobe's official website.*

📩 Instant Delivery After Payment

*Buy Other Products : ott24x7.com (Costumer)*
_Create Your Store : store.watshop.in (Seller)_

*Buy Instagram Followers : smm.ott24x7.com(Costumer)*
Create Your SMM Panel : smm.watshop.in (Seller)`,

`🎞️ *SHEMAROOME YEARLY PLAN* 🎞️

🔥 *Only ₹299*
✅ Activated on Your Account
✅ 1 Year Premium Access
✅ Bollywood, Bhakti & Regional Content
❌ No Sharing / No Redeem Hassle

⚡ Direct Activation
📩 DM TO ORDER NOW`,

`*🔥 MEGA 26 OTT COMBO — 1 YEAR 🔥*
26 OTT Apps in 1 Single Pack! 🎬

✅ 26 Premium OTT Platforms
✅ Hotstar + ZEE5 + SonyLIV + Prime
✅ Aha + Hoichoi + Discovery+ & More
✅ Movies, Web Series, Sports, Kids
✅ All Languages — Hindi, English, Regional

*🎁 1 FULL YEAR Validity*
💰 Save up to 70% vs MRP
📱 Watch on Mobile, TV, Laptop
🛡 100% Official Plans
⚡ Activated in 5–15 minutes

*💸 Special Combo Price: ₹[View Link]*
(All 26 Apps in One Payment!)

*🛒 BUY NOW 👇*

*📞 WhatsApp Support 24x7*

*⚠️ IMPORTANT NOTE:*

Some of Platforms in  combo plans are accessed via the
📱 Play Box TV app

*Some Can Be Access through Direct Official App*

After delivery → Login in PlayBox with same number
*→ Go to "Plans" → Tap "Claim"*`,

`🚨 LITE 23 COMBO — STEAL DEAL 🚨

🎬 23 OTT APPS in 1 Pack!
🎁 1 Year Full Validity
💰 Just ₹299
⚡ Instant Activation

✅ Movies, Sports, Web Series
✅ All Languages Covered
✅ 100% Official Plans

🛒 Order Here 👇

━━━━━━━━━━━━━━━━━━

⚠️ IMPORTANT NOTE:
Some of Platforms in combo plans are accessed via the
📱 Play Box TV app
Popular Plans Access through Direct Official App

After delivery → Login in PlayBox with same number
→ Go to "Plans" → Tap "Claim"`,
];

async function main() {
  const db = await getDb();

  const existing = db.exec('SELECT COUNT(*) FROM wa_offers');
  const count = existing[0]?.values[0][0] ?? 0;
  if (count > 0) {
    console.log(`wa_offers already has ${count} rows — skipping seed to avoid duplicates.`);
    console.log('Delete existing rows first if you want to re-seed.');
    process.exit(0);
  }

  let inserted = 0;
  for (const text of OFFERS) {
    db.run('INSERT INTO wa_offers (text, active) VALUES (?, ?)', [text, 0]);
    inserted++;
  }
  console.log(`Inserted ${inserted} WA offers (inactive drafts).`);

  // Wait for the 5s auto-save interval to flush to disk
  console.log('Waiting for DB flush...');
  await new Promise(r => setTimeout(r, 6000));
  console.log('Done. All offers saved to DB.');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
