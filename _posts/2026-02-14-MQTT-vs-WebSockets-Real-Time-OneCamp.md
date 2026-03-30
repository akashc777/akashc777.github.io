---
title : "Why I Used MQTT for Team Chat (Not WebSockets)  -  And What That Taught Me About Broker-Based Architectures"
image : "/assets/images/post/onecamp-hero.png"
author : "Akash Hadagali"
date: 2026-02-14 12:00:00 +0530
description : "Deep dive into OneCamp's real-time messaging layer  -  why MQTT beat raw WebSockets, how topics map to workspace entities, the Redux pattern that keeps UI and transport completely decoupled, and the scroll position problem that made me sob."
tags : ["OneCamp", "MQTT", "WebSockets", "Go", "Real-Time", "Architecture", "Redux"]
---

When I tell people I used MQTT for a team chat app, they look at me the way people look at someone who shows up to a dinner party with a thermos full of protein shake.

"Isn't that for IoT?"

Yes. Also no. Let me explain.

---

## The Problem With Naive WebSockets

When I started building the real-time layer for OneCamp, the obvious choice was WebSockets. Open a socket per user, broadcast messages, done.

Except  -  *not done*. Here's what "obvious" actually looks like in practice:

```
User A connects → ws://server/chat
User B connects → ws://server/chat  
User A sends a message
Server receives it
Server needs to find User B's open connection
Server broadcasts to B
✅ Works!

[10 minutes later]
You add a second server instance for load
User A is on Server 1
User B is on Server 2
User A sends a message
Server 1 has no idea where User B's connection is
❌ 
```

The moment you think about horizontal scaling, you realize raw WebSockets are just a transport  -  you still need pub/sub. So you bolt Redis Pub/Sub on top. Now you have WebSockets *and* Redis pub/sub. And you still have to write all the topic routing, subscription management, and fan-out logic yourself.

**Problem 2: Topic routing is all manual.** In a team chat app, every channel is a "room". Every DM is a "conversation". Every group chat is another namespace. With raw WebSockets, you're constantly writing logic like "find all connections subscribed to channel X, iterate over them, send the message, handle dead connections, clean up." That's just pub/sub implemented badly in your application layer.

**Problem 3: Reconnection is your problem.** Mobile network hiccup? Laptop lid closes? Your server has no idea the client dropped. You need heartbeats, keep-alives, and reconnect state. Completely solvable. Also completely annoying to write correctly.

---

## Enter MQTT 🤖

MQTT (Message Queuing Telemetry Transport) is a lightweight pub/sub protocol originally designed for low-bandwidth sensor networks transmitting temperature readings from unmanned oil pipelines in the middle of nowhere. It runs over TCP, has a tiny protocol overhead, and  -  crucially  -  **the broker handles everything**.

Here's how OneCamp's topic structure looks:

```
onecamp/{workspace_id}/dm/{grouping_id}           # DM conversation
onecamp/{workspace_id}/channel/{channel_uuid}     # Public channel
onecamp/{workspace_id}/user/{user_uuid}           # Per-user events
```

When User A sends a message to User B:
1. Go backend validates the message
2. Persists to Dgraph (message content) + Postgres (metadata)
3. Publishes the event to `onecamp/{workspace}/dm/{grouping_id}`

**EMQX** (the MQTT broker in the Docker stack) delivers it to every subscriber. The frontend subscribes to relevant topics on login. The Go backend doesn't maintain any connection state. The broker does.

This is a *massive* simplification. I went from "I need to build a connection registry, fan-out worker, and reconnect handler" to "publish this JSON to this topic." The broker is doing the hard part. I'm just sending messages.

---

## The 20-Event Message Type System

MQTT gives you raw bytes. You choose the format. Here's the full event taxonomy from OneCamp's frontend:

```typescript
export enum MqttMessageType {
    Post = 0,
    Post_Reaction,
    Post_Comment_Reaction,
    Channel_Typing,
    Chat,
    Chat_Reaction,
    Chat_Comment_Reaction,
    Chat_Typing,
    Post_Comment,
    Chat_Comment,
    User_Emoji_Status,
    User_Status,
    User_Device,
    Task_Comment_reaction,
    Task_Comment,
    Doc_Comment,
    Doc_Comment_reaction,
    Activity,
    Channel_call,
    Chat_call,
}
```

Twenty event types. Every single real-time thing that happens in OneCamp  -  new message, someone typing, emoji reaction, video call started, user went offline  -  flows through **one MQTT connection per browser tab**.

The frontend parses the `type` integer, routes it to the correct Redux slice, and updates UI. No separate WebSocket per feature. No polling. No long-polling (please, nobody use long-polling in 2026).

---

## The Redux Trick That Makes It All Work

Here's the pattern that surprised me most: **real-time events and REST API responses write into the same Redux state**.

When you load chat history via the API:
```typescript
dispatch(updateChats({ chatId: dmId, chats: apiResponse }));
```

When a new message arrives over MQTT:
```typescript
dispatch(createChat({
    chatId: mqttPayload.chat_uuid,
    chatText: mqttPayload.chat_html_text,
    dmId: mqttPayload.chat_grp_id,
    chatBy: { ... },
    attachments: [...],
}));
```

The React component only reads `chatSlice.chatMessages[dmId]` and renders. It has no idea whether the data came from the API or from MQTT. This is the separation of concerns you actually want: **the transport layer is completely invisible to the UI layer**.

This also naturally handles deduplication. The `createChat` reducer has a one-liner guard:

```typescript
if (state.chatMessages[dmId].some(c => c.chat_uuid === chatId)) return;
```

If the REST response and the MQTT event both carry the same message (which can happen during load), the second one is silently dropped. No duplicate messages. No "why is this message showing up twice" bug reports.

---

## The Reconnection Invalidation Pattern

When the MQTT connection drops and reconnects  -  mobile switching networks, laptop waking from sleep  -  there's a window where events were missed. No amount of "resume from last event" logic fully closes this gap cleanly.

OneCamp's approach: **on reconnect, nuke the in-memory message cache and re-fetch from the API**.

```typescript
// SYNC: Clear all loaded chat messages to force API refetch after stale reconnection
invalidateAllChatMessages: (state) => {
    state.chatMessages = {} as ExtendedChats
}
```

Heavy-handed? A little. Reliable? Completely. The API is the source of truth. Redis might have missed an event. Dgraph didn't.

Users notice a brief "loading" flash when they reconnect. Users do not notice reading a message that was never actually sent to them because the in-memory cache was stale. This was the right tradeoff.

---

## The Scroll Position Problem (My Favorite Bug) 😭

Here is a real edge case I did not anticipate at all: **scroll position restoration**.

When you leave a chat room and come back, you want to see where you left off  -  not get dumped at the bottom like nothing happened. Sounds easy.

It is not easy.

Messages load in paginated chunks. Each chunk changes the DOM height. A new message arrives and gets appended. The DOM height changes again. If you naively store "scroll to pixel 4820" and restore it, you land in completely the wrong place because the DOM is now 6000px tall and rebuilding.

The solution in `chatSlice`:

```typescript
chatScrollPositions: {} as ChatScrollPosition,
// Stores the UUID and relative offset of the top visible message

updateChatScrollPosition: (state, action: {payload: {chatId: string, key: string, offset: number}}) => {
    const {chatId, key, offset} = action.payload;
    state.chatScrollPositions[chatId] = { key, offset };
},
```

Instead of storing a pixel value (unstable), we store **which message UUID was at the top of the viewport** and the relative pixel offset from the top of that element. When restoring, we find that message element in the DOM and `scrollTo` it accounting for the offset.

The message UUIDs don't change. The DOM positions do. So anchor to the UUID, not the position.

This took me an embarrassingly long afternoon to figure out. I sat with it, drew diagrams, walked away, came back, drew more diagrams, and then had the "oh obviously" moment that only comes after you've already wasted three hours.

---

## Honest Tradeoffs

**MQTT doesn't solve persistence across disconnect.** QoS 1 (at-least-once delivery) means EMQX will retry delivery to connected clients. Offline clients miss it. That's fine  -  reconnect triggers an API refetch. But don't go in expecting MQTT to be a durable message queue. It's not.

**The broker is a dependency.** EMQX runs in Docker with restart policies. If it goes down, real-time stops (REST API still works  -  users can still load data, they just won't get live updates). For a self-hosted team of 50 people, this is acceptable. For "we need five-nines real-time", you'd want EMQX in cluster mode.

**MQTT.js (the browser client) has... quirks.** Connection state management in browser environments requires some defensive coding. The good news: once you've got the reconnect handling right, it's rock solid.

---

## Would I Do It Again?

Absolutely. The entire real-time layer  -  20 event types, DMs, channels, groups, typing indicators, call status, presence  -  is handled by ~450 lines of TypeScript in `mqttService.ts` and a broker config in Docker Compose.

The alternative was writing all of that fan-out logic myself. No thanks.

If you're building a self-hosted collaboration tool, give MQTT serious consideration. The broker does the hard work. Your job is just to define the topics.

---

*[OneCamp's frontend](https://github.com/OneMana-Soft/OneCamp-fe) is open source  -  `services/mqttService.ts` has the full client implementation. The self-hosted stack at [onemana.dev](https://onemana.dev/onecamp-product) includes a pre-configured EMQX instance.*
