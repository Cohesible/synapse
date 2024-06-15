## Introduction

The Standard Resource Library (SRL) is a collection of interfaces and utility functions that abstract away services provided by cloud providers. Common interfaces facilitate creating "cloud-agnostic" applications, which can be deployed to any cloud provider.

Having a standard right from the start, even if minimal, is intended to at least get the industry thinking about standardization. In all liklihood, standardization of cloud technology will take many years or even decades. As such, incremental standardization is a key requirement of the SRL.


### Balancing applicability and flexibility (WIP)

All abstractions come with a tradeoff: the more general something becomes, the fewer "free variables" can be changed by producers or relied on by consumers. Abstractions fundamentally restrict the information space in the domain they are applied. Information restrictions impede customization; the less I know about something, the less I can change. So an ideal abstraction is one that both minimizes information restriction while maximizing the number of consumers who can reliably use the abstraction.

For resources, this means allowing for inputs that do not fundamentally change the resulting interface. I should be able to use a resource the same way regardless of how it was created. Here are a few guidelines for creating such interfaces:

* Prefer generic (parameterized) interfaces
* Minimize the number of methods and properties
* When using discrete outputs:
    * Avoid "optional" (nullable) fields 
    * Keep the result of methods as simple as possible
* Avoid "convenience" methods, especially ones that create resources
    * Prefering creating a separate function/resource declaration instead
* Avoid optional parameters that only change the output shape, not behavior
    * Prefer creating utility functions instead. Documentation should have examples using the functions to increase visibility.


In practice, using a resource "the same way" has many asterisks attached. For example, a resource from one cloud provider may be able to tolerate much higher workloads compared to another one. This can cause all sorts of problems in applications that depend on specific timings or performance characteristics. 


### Per-vendor customizations
Taking inspiration from CSS vendor parameters, all SRL resources can be customized on a per-vendor basis. The idea is that this would allow "progressive enhancement" of applications, exposing additional features to the operator. Such things might include logging, analytics, or premium features that would otherwise be undesireable in the baseline implementation.


### Compliance Checking
Every resource interface has a baseline test suite that can be used to test for compliance. The nature of integrations means that it is up to the _integrator_ to run these tests. In the future, compliance checking could be centralized to give users more confidence in the libraries they're using.

These tests _only_ check that the implementation adheres to the interface; additional characteristics such as performance are not tested. Standardized performance tests are a possible future addition to the SRL.


### Governance (WIP)
Ideally, the SRL would be governed by an international standards organization. Until then, Cohesible will have stewardship over the SRL.