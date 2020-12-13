---
title : "Server Health Check Using Pure NodeJS"
image : "/assets/images/post/nodejs.png"
author : "Akash Hadagali"
date: 2019-09-12 11:12:58 +0530
description : "The app is a REST API for Making Health Checks and Notifies the User if there is Any Change in the Status of the response code.It is made using pure NodeJS ( No third-party packages)."
tags : ["Project", "NodeJS", "API"]

---
It's been a month since i have been learning NodeJS and from past one week I have been making a server health check using pure NodeJS (Without NPM) !

Github link : [Click here to see the GitHub repo]{:target="_blank"}

I have used callback pattern to implement it 🤨

##### What does it do 🧐 ?
In short it just pings the server and get the status and notifies the user in case of any change in the status code. Here is how its done.

<br>

**Users** \
Each users can have max 5 checks and in case of any change in status code users can be notified using twillio sms API.

<br>

**Tokens** \
Creation of session tokens for the users when they login \
It can be used to: 
* Update, delete user.
* Add, update, delete checks.
* Extend token validity.

<br>

**Checks** \
Each check consist of:
* Website URL
* Protocol (http/https)
* Required status code
* Method
* Timeout Seconds

<br>

All the data is stored locally in json form and time period can be set for compressing the logs




[Click here to see the GitHub repo]: https://github.com/akashc777/first_nodejs
