---
title : "Blockchain Use Case: Coffee Supply Chain"
image : "/assets/images/post/eth-w.jpg"
author : "Akash Hadagali"
date: 2020-06-27 22:00:58 +0530
description : "Used by Customer/Buyer to verify the Authenticity of the Coffee Beans by knowing Location of Growth using Blockchain."
tags : ["Project", "Ethereum", "Blockchain"]

---
Implementing this project was fun since i got to know so much about the actors in the supply chain and roles ! 

Github link : [Click here to see the GitHub repo]{:target="_blank"}

I have used the same tech as mentioned in [my previous blockchain blog]{:target="_blank"}

We store the data of an item. So, what is an item here 🤔 ?

{% highlight solidity %}
enum State 
  { 
    Harvested,  // 0
    Processed,  // 1
    Packed,     // 2
    ForSale,    // 3
    Sold,       // 4
    Shipped,    // 5
    Received,   // 6
    Purchased   // 7
    }

struct Item {
    uint    sku;  // Stock Keeping Unit (SKU)
    uint    upc; // Universal Product Code (UPC), generated by the Farmer, goes on the package, can be verified by the Consumer
    address ownerID;  // Metamask-Ethereum address of the current owner as the product moves through 8 stages
    address originFarmerID; // Metamask-Ethereum address of the Farmer
    string  originFarmName; // Farmer Name
    string  originFarmInformation;  // Farmer Information
    string  originFarmLatitude; // Farm Latitude
    string  originFarmLongitude;  // Farm Longitude
    uint    productID;  // Product ID potentially a combination of upc + sku
    string  productNotes; // Product Notes
    uint    productPrice; // Product Price
    State   itemState;  // Product State as represented in the enum above
    address distributorID;  // Metamask-Ethereum address of the Distributor
    address retailerID; // Metamask-Ethereum address of the Retailer
    address consumerID; // Metamask-Ethereum address of the Consumer
  }
{% endhighlight %}





Let's talk about the roles

**🧑🏼‍🌾 Farmer's Role :**  A farmer harvests the coffee beans, packs it and gives it a Universal Product Code (UPC). Farmer processes the item before packting it then sell it to distributers


**🧑🏼‍ Distributor's Role :** It can buy item from the farmer and ship it to the retailer.


***‍🏬 Retailer's Role :** It can buy item from the Distributer and sell it to the consumer.


**☕️👦🏻 Consumer's Role :** It can buy item from the Retailer.


**Note** \
The ownership of the item keeps changing in the supply chain until it reaches the consumer.



[Click here to see the GitHub repo]: https://github.com/akashc777/CoffeeSupplyChain
[my previous blockchain blog]: /post/Real-State-Title-ETH-Blockchain-Project.html
