const axios = require("axios");
const dotenv = require("dotenv");
const redis = require("redis");
const qs = require("qs");
const cheerio = require("cheerio");
const { init } = require("../utils/producer");
const {transport} = require("../utils/mail");
const { Worker } = require("bullmq");
const Bottleneck = require("bottleneck");
dotenv.config();

const worker = new Worker(
  "emailQueue",
  async (job) => {
    console.log(`Message rec id: ${job.id}`);
    console.log("Processing message");
    console.log(`Sending email to ${job.data.details.to}`);
    sendMail(job.data.details);
    console.log("Email sent");
  },
  {
    connection: {
      host: "127.0.0.1",
      port: "6379",
    },
  }
);

const limiter = new Bottleneck({
  minTime: 3000,
});

const client = redis.createClient(6379);
client.on("error", (err) => console.log("Redis Client Error", err));
client.connect().then(() => {
  console.log("Connected to Redis");
});

const redirectToOutlookConsent = (req, res) => {
  const authUrl = `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=${process.env.AZURE_CLIENT_ID}&response_type=code&redirect_uri=http://localhost:8000/outlook/oauth/outlook/callback&response_mode=query&scope=offline_access%20user.read%20mail.readwrite%20mail.read&state=12345`;
  res.redirect(authUrl);
};

const getAccessToken = async (code, grant_type_token) => {
  try {
    if (grant_type_token === "authorization_code") {
      const { data } = await axios.post(
        `https://login.microsoftonline.com/common/oauth2/v2.0/token`,
        qs.stringify({
          client_id: process.env.AZURE_CLIENT_ID,
          scope: "offline_access user.read mail.read",
          code: code,
          redirect_uri: "http://localhost:8000/outlook/oauth/outlook/callback",
          grant_type: grant_type_token,
          client_secret: process.env.AZURE_CLIENT_SECRET,
        }),
        {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
        }
      );
      const access_token = data.access_token;
      const refresh_token = data.refresh_token;
      return { access_token, refresh_token };
    } else if (grant_type_token === "refresh_token") {
      const { data } = await axios.post(
        `https://login.microsoftonline.com/common/oauth2/v2.0/token`,
        qs.stringify({
          client_id: process.env.AZURE_CLIENT_ID,
          scope: "offline_access user.read mail.read",
          refresh_token: code,
          grant_type: grant_type_token,
          client_secret: process.env.AZURE_CLIENT_SECRET,
        }),
        {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
        }
      );
      const access_token = data.access_token;
      const refresh_token = data.refresh_token;
      return { access_token, refresh_token };
    }
  } catch (error) {
    console.log(error);
  }
};

const getListOfMails = async (token) => {
  try {
    const data = await axios.get(
      "https://graph.microsoft.com/v1.0/me/messages",
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    );
    return data.data.value;
  } catch (error) {}
};

const outlookCallback = async (req, res) => {
  const { code } = req.query;
  if (!code) {
    return res.status(400).send("Authorization code missing.");
  }

  try {
    const { access_token, refresh_token } = await getAccessToken(
      code,
      "authorization_code"
    );
    const profile = await axios.get("https://graph.microsoft.com/v1.0/me", {
      headers: {
        Authorization: `Bearer ${access_token}`,
      },
    });
    req.session.user = {
      id: profile.data.id,
      email: profile.data.userPrincipalName,
      name: profile.data.displayName,
    };
    req.session.save();
    client.set(
      `access_token:${req.session.user.email}`,
      access_token,
      redis.print
    );
    client.set(
      `refresh_token:${req.session.user.email}`,
      refresh_token,
      redis.print
    );

    res.redirect("http://localhost:8000/outlook/automate");
  } catch (error) {
    console.log(error);
  }
};

const parseMail = (mail) => {
  const $ = cheerio.load(mail.body.content);
  let body = "";
  const elementToProof = $(".elementToProof");
  if (elementToProof.length > 0) {
    body = elementToProof.text().trim();
  } else {
    body = "No data found";
  }
  const parsedMail = {
    id: mail.id,
    subject: mail.subject,
    bodyPreview: mail.bodyPreview,
    from: mail.from.emailAddress,
    body: body,
    cc: mail.ccRecipients,
    bcc: mail.bccRecipients,
  };
  return parsedMail;
};

const labelAndReplyMail = async (mail) => {
  try {
    const { data } = await axios.request({
      method: "POST",
      url: 'https://chatgpt-api8.p.rapidapi.com/',
      headers: {
        'content-type': 'application/json',
        'X-RapidAPI-Key': process.env.X_RapidAPI_Key,
        'X-RapidAPI-Host': 'chatgpt-api8.p.rapidapi.com'
      },    
      data: [
          {
            content: `From the given text categorise the data into a single world ans. It can be Interested, Not interested, More information 
  
          text : ${mail.body},
          
          Based on that word write a reply, just the subject and body to ${mail.from.name} following the below rules:
          if Interested: write an email on behalf of Raj, Manager, Reachinbox asking ${mail.from.name}  if they are willing to hop on to a demo call by suggesting a time.
          if Not Interested: write an email on behalf of Raj, Manager, Reachinbox thanking ${mail.from.name} for their time and asking them if they would like to be contacted in the future from Raj
          if More Information : write an email on behalf of Raj, Manager, Reachinbox asking ${mail.from.name} if they would like more information about the product from Raj. 
          And i need information in the following json format
          {
          "label" : Label,
          "subject":Subject,
          "body":body,
          }
          `,
            role: "user",
          },
        ],
    });

    let text = data.text;
    const response = JSON.parse(text);
    return response;
  } catch (error) {
    console.log(error);
  }
};

const moveMailToFolder = async (access_token, mail, folderId) => {
  const { data } = await axios.post(
    `https://graph.microsoft.com/v1.0/me/messages/${mail.id}/move`,
    {
      DestinationId: folderId,
    },
    {
      headers: {
        Authorization: `Bearer ${access_token}`,
        "Content-Type": "application/json",
      },
    }
  );
};

const sendMail = (details) => {
  transport().sendMail({
    from: "emailverification@email.com",
    to: details.to,
    subject: `Reply to ${details.subject}`,
    html: `<p>${details.body}</p>`,
  });
};

const readAndWriteMails = async (req, res) => {
  try {
    const curr_refresh_token = await client.get(
      `refresh_token:${req.session.user.email}`
    );

    const { access_token, refresh_token } = await getAccessToken(
      curr_refresh_token,
      "refresh_token"
    );

    client.set(
      `access_token:${req.session.user.email}`,
      access_token,
      redis.print
    );
    client.set(
      `refresh_token:${req.session.user.email}`,
      refresh_token,
      redis.print
    );

    const mails = await getListOfMails(access_token);

    let currentFolders = await axios.get(
      "https://graph.microsoft.com/v1.0/me/mailFolders",
      {
        headers: {
          Authorization: `Bearer ${access_token}`,
        },
      }
    );

    let existingLabels = currentFolders.data.value.reduce(
      (acc, label) => ({ ...acc, [label.displayName]: label.id }),
      {}
    );

    const foldersToCreate = [
      "Interested",
      "Not Interested",
      "More Information",
    ].filter((label) => !existingLabels.hasOwnProperty(label));

    const createLabelPromises = foldersToCreate.map(async (label) => {
      return axios.post(
        `https://graph.microsoft.com/v1.0/me/mailFolders`,
        {
          displayName: label,
          isHidden: false,
        },
        {
          headers: {
            Authorization: `Bearer ${access_token}`,
            "Content-Type": "application/json",
          },
        }
      );
    });

    const response = await Promise.all(createLabelPromises);
    console.log(response);
    currentFolders = await axios.get(
      "https://graph.microsoft.com/v1.0/me/mailFolders",
      {
        headers: {
          Authorization: `Bearer ${access_token}`,
        },
      }
    );
    
    existingLabels = currentFolders.data.value.reduce(
      (acc, label) => ({ ...acc, [label.displayName]: label.id }),
      {}
    );
    mails.map(async (mail) => {
      await limiter.schedule(async () => {
        const parsedMail = parseMail(mail);
        const labelAndReply = await labelAndReplyMail(parsedMail);
        moveMailToFolder(
          access_token,
          mail,
          existingLabels[labelAndReply.label]
        );
        init({
          to: parsedMail.from.address,
          cc: parsedMail.cc,
          bcc: parsedMail.bcc,
          subject: labelAndReply.subject,
          body: labelAndReply.body,
        });
      });
    });
    res.send(`You have successfully authenticated with Google and Sent Replies to your Outlook. You can now close this tab`);
  } catch (error) {
    console.log(error);
  }
};

module.exports = {
  redirectToOutlookConsent,
  outlookCallback,
  readAndWriteMails,
};
