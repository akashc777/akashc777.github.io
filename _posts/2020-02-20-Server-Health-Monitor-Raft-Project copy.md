---
title : "Server Health Monitoring Using Raft Algorithm"
image : "/assets/images/post/raft.png"
author : "Akash Hadagali"
date: 2020-02-20 11:12:58 +0530
description : "server health monitoring using raft algorithm also submitted as mini project in my college assignment. Raft algorithm for distributed systems."
tags : ["Project", "Go"]

---
I have been learning about docker engine for past 2 months and I got to know that docker swarm uses Raft algorithm which has been implemented natively without other services like etcd. I made a simple project which monitors server health in a distributed system to understand Raft algorithm.
I implemented it using GoLang.


Github link : [Click here to see the GitHub repo]{:target="_blank"}

Before getting into project details lets first understand Raft Algorithm

**Raft Alorithm:** Raft is a sophisticated algorithm that is used in etcd for monitoring servers and more. It uses leader election to monitor servers and log replication to maintain same state among all the nodes in the cluster. Its used in most of the places because its easy to implement and understand. It also provides fault tolerance.

**Know more about Raft and its uses:** 
* [Swarm Raft Quorum and Recovery (Laura Frank from DockerCon 2017)]{:target="_blank"}
* [The Raft Consensus Algorithm]{:target="_blank"}

**🤨 So what happens when you run the code ? 🤔** \
When you run the code in a cluster following steps are executed.
1. No heart beat is receieved or sent so leader election happens and a leader is elected.
2. Leader sends a heart beat to every node and collects server health as a reponse.
3. This log is replicated to all the nodes. If leader does get the quorum then the logs are commited
4. If the leader fails then we go back to step 1 else we go back to step 2.


**Note:** This project doesn't flush the memory. So the all the logs will be in the memory.

Want to learn Raft in a interactive way ? \
Check out [The secret lives of data]{:target="_blank"}

[Click here to see the GitHub repo]: https://github.com/akashc777/miniproj.akash.page
[Swarm Raft Quorum and Recovery (Laura Frank from DockerCon 2017)]: https://www.youtube.com/watch?v=Qsv-q8WbIZY
[The Raft Consensus Algorithm]: https://raft.github.io/
[The secret lives of data]: http://thesecretlivesofdata.com/raft/